// Git smart HTTP: the pkt-line wire, the packfile format (read and write, deltas included), and the
// two services. upload-pack speaks protocol v2 (ls-refs and fetch, shallow/deepen included);
// receive-pack speaks v0 with report-status, side-band-64k and delete-refs. There is no git binary:
// every object is hashed, inflated and stored here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO, hashObject, parseCommit, parseTag, parseTree } from './store.ts';

const AGENT = 'makefun-forge/1.0';
const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const SIDEBAND_CHUNK = 32768;

// ---------------------------------------------------------------- pkt-line

export function pkt(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** Split a pkt-line stream into packets plus the bytes after the first flush (a push's packfile). */
export function parsePktLines(buf) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ type: 'flush' });
      offset += 4;
      if (packets.length > 0 && offset <= buf.length) {
        // A push's packfile follows the command flush; stop reading pkt-lines there.
        const rest = buf.subarray(offset);
        return { packets, rest };
      }
      continue;
    }
    if (length === 1) {
      packets.push({ type: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ type: 'flush' });
      offset += 4;
      continue;
    }
    if (offset + length > buf.length) break;
    packets.push({ type: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

function pktText(packet) {
  return packet.type === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

// ---------------------------------------------------------------- packfile writing

function objectHeader(type, size) {
  const code = TYPE_CODE[type];
  let remaining = size;
  let byte = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  const bytes = [];
  while (remaining > 0) {
    bytes.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** A version-2 pack of full objects (no deltas), checksummed. Deflated bytes are cached per object. */
export function writePack(objects) {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const object of objects) {
    parts.push(objectHeader(object.type, object.data.length));
    if (object.z === undefined || object.z === null) object.z = deflateSync(object.data);
    parts.push(object.z);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- packfile reading

function readVarintSize(buf, start) {
  let offset = start;
  let byte = buf[offset++];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buf, start) {
  let offset = start;
  let byte = buf[offset++];
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buf, offset, end) {
  const result = inflateSync(buf.subarray(offset, end), { info: true });
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base, delta) {
  let offset = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  readSize();
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let baseOffset = 0;
      let size = 0;
      if (op & 0x01) baseOffset += delta[offset++];
      if (op & 0x02) baseOffset += delta[offset++] * 0x100;
      if (op & 0x04) baseOffset += delta[offset++] * 0x10000;
      if (op & 0x08) baseOffset += delta[offset++] * 0x1000000;
      if (op & 0x10) size += delta[offset++];
      if (op & 0x20) size += delta[offset++] * 0x100;
      if (op & 0x40) size += delta[offset++] * 0x10000;
      if (size === 0) size = 0x10000;
      base.copy(out, written, baseOffset, baseOffset + size);
      written += size;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      written += op;
      offset += op;
    } else {
      throw new Error('pack: invalid delta opcode 0');
    }
  }
  return out.subarray(0, written);
}

/**
 * Read a pack: header, every entry (full objects, ofs-delta and ref-delta), trailer checked.
 * `resolveBase` supplies objects the pack itself does not carry (a thin pack).
 */
export function readPack(buf, resolveBase) {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad header');
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  const end = buf.length - 20;
  const trailer = buf.subarray(end).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, end)).digest('hex');
  if (trailer !== computed) throw new Error('pack: checksum mismatch');
  const entries = [];
  const byOffset = new Map();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    const header = readVarintSize(buf, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: start, typeCode, size: header.size, baseOffset: null, baseOid: null, data: null };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buf, offset);
      offset = base.next;
      entry.baseOffset = start - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeCode < 1 || typeCode > 4) {
      throw new Error(`pack: bad object type ${typeCode}`);
    }
    const inflated = inflateAt(buf, offset, end);
    entry.data = inflated.data;
    offset = inflated.next;
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const resolved = new Map();
  const resolve = (entry) => {
    if (resolved.has(entry.offset)) return resolved.get(entry.offset);
    let object;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      object = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    } else {
      let base;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('pack: ofs-delta names an unknown offset');
        base = resolve(baseEntry);
      } else {
        const oid = entry.baseOid;
        const fromPack = entries.find((candidate) => hashObject(CODE_TYPE[candidate.typeCode] ?? 'blob', candidate.data) === oid);
        if (fromPack !== undefined && fromPack !== entry) {
          base = resolve(fromPack);
        } else {
          base = resolveBase === undefined ? undefined : resolveBase(oid);
        }
        if (base === undefined) throw new Error(`pack: ref-delta base ${oid} is missing`);
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolved.set(entry.offset, object);
    return object;
  };
  const objects = [];
  for (const entry of entries) {
    const object = resolve(entry);
    objects.push({ type: object.type, data: object.data, oid: hashObject(object.type, object.data) });
  }
  return { version, count, objects };
}

// ---------------------------------------------------------------- graph walks

/** Add every object reachable from `oid` (commit/tag/tree/blob) to `out`, skipping `skip`. */
export function collectReachable(repo, oid, out, skip) {
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current === null) continue;
    if (out.has(current)) continue;
    if (skip !== undefined && skip.has(current)) continue;
    const object = repo.getObject(current);
    if (object === undefined) continue;
    out.add(current);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

/** Add one commit, its tree and every blob under it (never its parents) to `out`, skipping `skip`. */
function collectCommitObjects(repo, oid, out, skip) {
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current === null) continue;
    if (out.has(current)) continue;
    if (skip !== undefined && skip.has(current)) continue;
    const object = repo.getObject(current);
    if (object === undefined) continue;
    out.add(current);
    if (object.type === 'commit') stack.push(parseCommit(object.data).tree);
    else if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
    else if (object.type === 'tag') stack.push(parseTag(object.data).object);
  }
  return out;
}

/** Walk `depth` generations of commits from `wants`; returns the commits and each one's generation. */
function walkDepth(repo, wants, depth) {
  const generation = new Map();
  let frontier = wants.map((want) => [want, 0]);
  while (frontier.length > 0) {
    const next = [];
    for (const [oid, gen] of frontier) {
      if (generation.has(oid)) continue;
      generation.set(oid, gen);
      const object = repo.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (gen + 1 >= depth) continue;
      for (const parent of parseCommit(object.data).parents) if (!generation.has(parent)) next.push([parent, gen + 1]);
    }
    frontier = next;
  }
  return generation;
}

function peelTag(repo, oid) {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = repo.getObject(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- advertisements

function capabilityList(extra) {
  return ['multi_ack', 'multi_ack_detailed', 'side-band', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', 'include-tag', 'agent=' + AGENT, ...extra];
}

function v2Advertisement() {
  const parts = [pkt('version 2\n'), pkt(`agent=${AGENT}\n`), pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done\n'), pkt('object-format=sha1\n'), FLUSH];
  return Buffer.concat(parts);
}

function v0RefAdvertisement(repo, service) {
  const caps = service === 'git-upload-pack'
    ? capabilityList([`symref=HEAD:refs/heads/${repo.defaultBranch}`]).join(' ')
    : ['report-status', 'delete-refs', 'side-band-64k', 'quiet', 'ofs-delta', `agent=${AGENT}`].join(' ');
  const lines = [];
  const refs = [];
  const head = repo.tip(`refs/heads/${repo.defaultBranch}`);
  if (head !== null && head !== undefined) refs.push({ name: 'HEAD', oid: head, peel: null });
  for (const [ref, oid] of [...repo.refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const object = repo.getObject(oid);
    const peeled = object !== undefined && object.type === 'tag' ? peelTag(repo, oid) : null;
    refs.push({ name: ref, oid, peel: peeled });
  }
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO} capabilities^{}\u0000${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${caps}` : '';
      lines.push(pkt(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peel !== null && service === 'git-upload-pack') lines.push(pkt(`${ref.peel} ${ref.name}^{}\n`));
    });
  }
  lines.push(FLUSH);
  return Buffer.concat([pkt(`# service=${service}\n`), FLUSH, ...lines]);
}

// ---------------------------------------------------------------- ls-refs

function lsRefs(repo, options) {
  const { prefixes, peel, symrefs, unborn } = options;
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const head = repo.tip(headTarget);
  if (prefixes.length === 0 && symrefs) {
    if (head === null) {
      if (unborn) lines.push(pkt(`unborn HEAD symref-target:${headTarget}\n`));
    } else {
      lines.push(pkt(`${head} HEAD symref-target:${headTarget}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name);
    const object = repo.getObject(oid);
    let suffix = '';
    if (peel && object !== undefined && object.type === 'tag') suffix = ` peeled:${peelTag(repo, oid)}`;
    lines.push(pkt(`${oid} ${name}${suffix}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch

function sideband(pack) {
  const parts = [pkt('packfile\n')];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, offset + SIDEBAND_CHUNK);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(repo, request) {
  const { wants, haves, shallowGiven, depth } = request;
  const parts = [];
  const known = haves.filter((have) => repo.hasObject(have));
  if (haves.length > 0) {
    const ack = [pkt('acknowledgments\n')];
    if (known.length > 0) for (const have of known) ack.push(pkt(`ACK ${have}\n`));
    else ack.push(pkt('NAK\n'));
    ack.push(FLUSH);
    parts.push(Buffer.concat(ack));
  }
  const skip = new Set();
  // A shallow client holds only the boundary commits it names (and their trees), not their
  // ancestors: exclude exactly that much, or a deepen would resend nothing and lose the parent.
  for (const have of known) {
    if (depth !== null) collectCommitObjects(repo, have, skip);
    else collectReachable(repo, have, skip);
  }

  let commits;
  const shallowLines = [];
  const unshallowLines = [];
  if (depth !== null && Number.isFinite(depth) && depth > 0) {
    const generation = walkDepth(repo, wants, depth);
    commits = [...generation.keys()];
    const included = new Set(commits);
    for (const [oid, gen] of generation) {
      const object = repo.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent))) shallowLines.push(oid);
      if (gen < depth - 1 && shallowGiven.includes(oid)) unshallowLines.push(oid);
    }
    for (const boundary of shallowGiven) if (!included.has(boundary)) shallowLines.push(boundary);
  } else {
    const reachable = new Set();
    for (const want of wants) collectReachable(repo, want, reachable);
    commits = [...reachable];
    for (const boundary of shallowGiven) shallowLines.push(boundary);
  }
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    const section = [pkt('shallow-info\n')];
    for (const oid of [...new Set(shallowLines)]) section.push(pkt(`shallow ${oid}\n`));
    for (const oid of [...new Set(unshallowLines)]) section.push(pkt(`unshallow ${oid}\n`));
    section.push(FLUSH);
    parts.push(Buffer.concat(section));
  }

  const objects = new Set();
  for (const commit of commits) collectCommitObjects(repo, commit, objects, skip);
  const list = [];
  for (const oid of objects) {
    const object = repo.getObject(oid);
    if (object !== undefined) list.push(object);
  }
  parts.push(sideband(writePack(list)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

function pushReport(lines, sidebandWanted) {
  const inner = Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]);
  if (!sidebandWanted) return inner;
  const parts = [];
  for (let offset = 0; offset < inner.length; offset += SIDEBAND_CHUNK) {
    const chunk = inner.subarray(offset, offset + SIDEBAND_CHUNK);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a push's command list, store its packfile, apply the fast-forward rule, answer the report. */
function receivePack(repo, body) {
  const { packets, rest } = parsePktLines(body);
  const commands = [];
  let sidebandWanted = false;
  let first = true;
  for (const packet of packets) {
    if (packet.type !== 'data') continue;
    let text = packet.payload.toString('utf8');
    if (first) {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        const caps = text.slice(nul + 1).trim();
        if (caps.split(' ').includes('side-band-64k')) sidebandWanted = true;
        text = text.slice(0, nul);
      }
      first = false;
    }
    const trimmed = text.replace(/\n$/, '');
    if (trimmed === '') continue;
    const space1 = trimmed.indexOf(' ');
    const space2 = trimmed.indexOf(' ', space1 + 1);
    if (space1 < 0 || space2 < 0) continue;
    commands.push({ oldOid: trimmed.slice(0, space1), newOid: trimmed.slice(space1 + 1, space2), ref: trimmed.slice(space2 + 1) });
  }
  let unpackLine = 'unpack ok\n';
  if (rest !== undefined && rest.length > 0) {
    try {
      const pack = readPack(rest, (oid) => repo.getObject(oid));
      for (const object of pack.objects) if (!repo.hasObject(object.oid)) repo.objects.set(object.oid, { type: object.type, data: object.data });
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message.replace(/\n/g, ' ') : 'error'}\n`;
    }
  }
  const lines = [unpackLine];
  const ok = unpackLine === 'unpack ok\n';
  for (const command of commands) {
    if (!ok) {
      lines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO) {
      if (current === undefined) lines.push(`ng ${command.ref} delete-nonexistent\n`);
      else {
        repo.deleteRef(command.ref);
        lines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      repo.setRef(command.ref, command.newOid);
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== ZERO && command.oldOid !== current) {
      lines.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (!repo.isAncestor(current, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.setRef(command.ref, command.newOid);
    lines.push(`ok ${command.ref}\n`);
  }
  return pushReport(lines, sidebandWanted);
}

// ---------------------------------------------------------------- HTTP glue

function send(res, status, contentType, body) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

/** Answer one smart-HTTP request. `sub` is the path after "<owner>/<repo>.git". */
export function handleGit(res, repo, service, sub, query, headers, body) {
  if (sub === '/info/refs') {
    if (service === 'git-upload-pack') {
      const protocol = (headers['git-protocol'] ?? '').toString();
      const v2 = /version=2/.test(protocol);
      send(res, 200, 'application/x-git-upload-pack-advertisement', v2 ? v2Advertisement() : v0RefAdvertisement(repo, 'git-upload-pack'));
      return true;
    }
    if (service === 'git-receive-pack') {
      send(res, 200, 'application/x-git-receive-pack-advertisement', v0RefAdvertisement(repo, 'git-receive-pack'));
      return true;
    }
    send(res, 403, 'text/plain', Buffer.from('smart HTTP only\n'));
    return true;
  }
  if (sub === '/git-upload-pack') {
    const { packets } = parsePktLines(body);
    const first = packets.find((packet) => packet.type === 'data');
    const command = first === undefined ? '' : pktText(first);
    if (command === 'command=ls-refs') {
      const options = { prefixes: [], peel: false, symrefs: false, unborn: false };
      let inArgs = false;
      for (const packet of packets) {
        if (packet.type === 'delim') {
          inArgs = true;
          continue;
        }
        if (!inArgs || packet.type !== 'data') continue;
        const line = pktText(packet);
        if (line === 'peel') options.peel = true;
        else if (line === 'symrefs') options.symrefs = true;
        else if (line === 'unborn') options.unborn = true;
        else if (line.startsWith('ref-prefix ')) options.prefixes.push(line.slice(11));
      }
      send(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, options));
      return true;
    }
    if (command === 'command=fetch') {
      const request = { wants: [], haves: [], shallowGiven: [], depth: null };
      let inArgs = false;
      for (const packet of packets) {
        if (packet.type === 'delim') {
          inArgs = true;
          continue;
        }
        if (!inArgs || packet.type !== 'data') continue;
        const line = pktText(packet);
        if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) request.shallowGiven.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
      }
      const wants = request.wants.filter((want) => repo.hasObject(want));
      if (wants.length === 0) {
        send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([FLUSH]));
        return true;
      }
      send(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, { ...request, wants }));
      return true;
    }
    send(res, 400, 'text/plain', Buffer.from('unsupported upload-pack request\n'));
    return true;
  }
  if (sub === '/git-receive-pack') {
    send(res, 200, 'application/x-git-receive-pack-result', receivePack(repo, body));
    return true;
  }
  return false;
}

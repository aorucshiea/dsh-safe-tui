// Session-log repair for dsh-safe-tui.
//
// DSH's JSONL session persistence treats duplicate/backtracking event seq as
// corruption. This module recognizes the common cancel/interrupt pattern:
// a synthetic `tool/result -> step/end -> turn/end` block followed by real
// events that rewind to the same seq. It removes the earlier synthetic block
// and rewrites a contiguous, readable log.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { decodeStorageRecord, packChunkRuns } from '@deepseek-ai/dsh-session'

const ZSTD_MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  let tornStart
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) { tornStart = start; break }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid Zstandard frame magic')
    offset += 4
    if (offset === buffer.length) { tornStart = start; break }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('reserved Zstandard frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) { tornStart = start; break }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) { tornStart = start; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('reserved Zstandard block type')
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { tornStart = start; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (tornStart !== undefined) break
    if (checksum) {
      if (buffer.length - offset < 4) { tornStart = start; break }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  if (tornStart !== undefined) throw new Error('torn Zstandard frame is not repairable here')
  return frames
}

function decodeSessionLog(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    const frames = scanZstdFrames(buffer)
    let text = ''
    for (const frame of frames) {
      text += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    }
    return text
  }
  return buffer.toString('utf8')
}

function encodeSessionLog(content, zstd) {
  const text = content.endsWith('\n') ? content : content + '\n'
  if (!zstd) return Buffer.from(text, 'utf8')
  const newline = text.indexOf('\n')
  if (newline === -1) throw new Error('session log has no header line')
  const headerBytes = Buffer.from(text.slice(0, newline + 1), 'utf8')
  const bodyBytes = Buffer.from(text.slice(newline + 1), 'utf8')
  return Buffer.concat([
    zstdCompressSync(headerBytes, CHECKSUM_OPTIONS),
    zstdCompressSync(bodyBytes, CHECKSUM_OPTIONS),
  ])
}

function parseSession(content) {
  const lines = content.split('\n')
  const header = lines[0] ?? ''
  const events = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`unparsable session log line ${i + 1}`)
    }
    for (const event of decodeStorageRecord(parsed)) {
      if (typeof event.seq !== 'number') continue
      events.push(event)
    }
  }
  return { header, events }
}

/** Remove the earlier duplicate/synthetic rewind block and return a clean log. */
export function repairDuplicateSeqContent(content) {
  const { header, events } = parseSession(content)
  if (events.length === 0) return content

  const kept = []
  let expected = events[0].seq
  let changed = false

  for (const event of events) {
    if (event.seq === expected) {
      kept.push(event)
      expected += 1
      continue
    }
    if (event.seq < expected) {
      // Duplicate/rewind: drop the earlier synthetic block that started here.
      while (kept.length > 0 && kept[kept.length - 1].seq >= event.seq) kept.pop()
      changed = true
      expected = event.seq
      if (event.seq === expected) {
        kept.push(event)
        expected += 1
      }
      continue
    }
    // Forward gap: keep but align to the observed seq (safe heuristic).
    kept.push(event)
    expected = event.seq + 1
    changed = true
  }

  if (!changed) return content

  const records = packChunkRuns(kept)
  const repaired = [header, ...records.map((record) => JSON.stringify(record))]
  return repaired.join('\n').replace(/\n+$/, '') + '\n'
}

/** Repair one session file in place. Returns the backup path, or null if nothing changed. */
export function repairSessionFile(file) {
  const zstd = file.endsWith('.zstd')
  const buffer = readFileSync(file)
  const content = decodeSessionLog(buffer)
  const repaired = repairDuplicateSeqContent(content)
  if (repaired === content) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.corrupt-${stamp}.bak`
  copyFileSync(file, backup)
  writeFileSync(file, encodeSessionLog(repaired, zstd))
  return backup
}

export { decodeSessionLog, encodeSessionLog, scanZstdFrames }

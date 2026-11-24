import { describe, expect, it } from 'vitest';
import { patchInitSegmentDuration } from './mp4-transmuxer';

const u32 = (v: number) =>
  new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

const UNKNOWN_DURATION = 0xffffffff;

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payloadLen = payloads.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + payloadLen);
  out.set(u32(out.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let off = 8;
  for (const p of payloads) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** version 0 full box：version(1)+flags(3)=0，其后是若干 u32 字段 */
function fullBox(fields: number[]): Uint8Array {
  const out = new Uint8Array(4 + fields.length * 4);
  fields.forEach((v, i) => out.set(u32(v), 4 + i * 4));
  return out;
}

function mediaHeader(scale: number, duration = UNKNOWN_DURATION): Uint8Array {
  return box('mdhd', fullBox([0, 0, scale, duration]));
}

function track(header: Uint8Array, duration = UNKNOWN_DURATION): Uint8Array {
  return box('trak', box('tkhd', fullBox([0, 0, 1, 0, duration])), box('mdia', header));
}

function initSegment(duration: number, ...tracks: Uint8Array[]): Uint8Array {
  const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d]));
  const moov = box('moov', box('mvhd', fullBox([0, 0, 90_000, duration])), ...tracks);
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}

describe('patchInitSegmentDuration', () => {
  it('使用电影和音视频轨道各自的时基，并保留原始缓冲', () => {
    const init = initSegment(UNKNOWN_DURATION, track(mediaHeader(90_000)), track(mediaHeader(48_000)));
    const raw = init.slice();
    expect(patchInitSegmentDuration(init, 6)).toEqual(
      initSegment(540_000, track(mediaHeader(90_000, 540_000), 540_000), track(mediaHeader(48_000, 288_000), 540_000))
    );
    expect(init).toEqual(raw);
  });

  it.each([undefined, 0, Number.NaN, Infinity, 100_000])('无法写入版本 0 时长字段时回填零 (%s)', (seconds) => {
    const init = initSegment(UNKNOWN_DURATION, track(mediaHeader(48_000)));
    expect(patchInitSegmentDuration(init, seconds)).toEqual(initSegment(0, track(mediaHeader(48_000, 0), 0)));
  });

  it('保留明确时长、版本 1 以及过短的 mdhd 字段', () => {
    const versionOne = fullBox([0, 0, 0, 0, 48_000, UNKNOWN_DURATION, UNKNOWN_DURATION]);
    versionOne[0] = 1;
    const init = initSegment(
      100,
      track(mediaHeader(48_000, 99), 100),
      track(box('mdhd', versionOne), 100),
      track(box('mdhd', fullBox([0, 0, 48_000])), 100)
    );
    expect(patchInitSegmentDuration(init, 6)).toEqual(init);
  });
});

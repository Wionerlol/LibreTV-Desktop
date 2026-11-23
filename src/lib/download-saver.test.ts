import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectSavingCapability, pickSaveTarget } from './download-saver';

afterEach(() => vi.unstubAllGlobals());

describe('download save targets', () => {
  it('rejects a memory target write that crosses the fixed limit before copying it', async () => {
    vi.stubGlobal('window', {});
    const target = await pickSaveTarget('fixture.ts');
    expect(target.kind).toBe('memory');
    await target.write(Uint8Array.of(1));
    const oversized = new Uint8Array();
    Object.defineProperty(oversized, 'byteLength', { value: 500 * 1024 * 1024 });
    await expect(target.write(oversized)).rejects.toThrow(/500 MiB/);
    await target.abort();
  });

  it('surfaces disk picker failure instead of writing to memory', async () => {
    const pickerError = new Error('fixture denied');
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn(async () => { throw pickerError; }),
    });
    await expect(pickSaveTarget('fixture.ts')).rejects.toBe(pickerError);
  });

  it('binds a desktop target to its lease and streams exact bounded byte slices', async () => {
    const bridge = {
      pick: vi.fn(async () => ({ leaseId: 'fixture-lease' })),
      write: vi.fn<(id: string, bytes: ArrayBuffer) => Promise<void>>().mockResolvedValue(undefined),
      finish: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    vi.stubGlobal('window', { libretvDownloads: bridge });
    expect(detectSavingCapability()).toBe('native');
    const target = await pickSaveTarget('fixture.ts', { taskId: 'dl_1_test' });
    const bytes = new Uint8Array(1024 * 1024 + 5);
    bytes[1] = 7;
    bytes[bytes.length - 2] = 9;
    await target.write(bytes.subarray(1, -1));
    await target.close();
    await target.abort();

    expect(bridge.pick).toHaveBeenCalledWith('dl_1_test', 'fixture.ts');
    expect(bridge.write.mock.calls.map(([id, chunk]) => [id, chunk.byteLength])).toEqual([
      ['fixture-lease', 1024 * 1024],
      ['fixture-lease', 3],
    ]);
    expect(new Uint8Array(bridge.write.mock.calls[0][1])[0]).toBe(7);
    expect(new Uint8Array(bridge.write.mock.calls[1][1]).at(-1)).toBe(9);
    expect(bridge.finish).toHaveBeenCalledWith('fixture-lease');
    expect(bridge.abort).not.toHaveBeenCalled();
  });
});

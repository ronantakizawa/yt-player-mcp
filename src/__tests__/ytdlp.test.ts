import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../validate.js', () => ({
  getBrowser: vi.fn(() => 'chrome'),
}));

import { spawn } from 'child_process';
import { fetchFeed, fetchVideoInfo, pickVideoFields } from '../ytdlp.js';

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function emitSuccess(proc: any, data: string) {
  proc.stdout.emit('data', Buffer.from(data));
  proc.emit('close', 0);
}

function emitFailure(proc: any, code: number, stderr = '') {
  if (stderr) {
    proc.stderr.emit('data', Buffer.from(stderr));
  }
  proc.emit('close', code);
}

function emitSpawnError(proc: any, message: string) {
  proc.emit('error', new Error(message));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// pickVideoFields
// ---------------------------------------------------------------------------
describe('pickVideoFields', () => {
  it('extracts exactly the expected fields', () => {
    const entry = {
      title: 'Test Video',
      url: 'https://youtube.com/watch?v=abc',
      channel: 'TestChannel',
      duration: 120,
      view_count: 5000,
      upload_date: '20250101',
    };
    expect(pickVideoFields(entry)).toEqual(entry);
  });

  it('returns undefined for missing fields', () => {
    const result = pickVideoFields({});
    expect(result).toEqual({
      title: undefined,
      url: undefined,
      channel: undefined,
      duration: undefined,
      view_count: undefined,
      upload_date: undefined,
    });
  });

  it('ignores extra fields', () => {
    const entry = {
      title: 'Vid',
      url: 'http://example.com',
      channel: 'Ch',
      duration: 60,
      view_count: 10,
      upload_date: '20240101',
      description: 'should be ignored',
      like_count: 999,
    };
    const result = pickVideoFields(entry);
    expect(result).toEqual({
      title: 'Vid',
      url: 'http://example.com',
      channel: 'Ch',
      duration: 60,
      view_count: 10,
      upload_date: '20240101',
    });
    expect((result as any).description).toBeUndefined();
    expect((result as any).like_count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchFeed
// ---------------------------------------------------------------------------
describe('fetchFeed', () => {
  it('calls spawn with correct args including --playlist-start/end', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = fetchFeed('https://youtube.com/feed', 5);
    emitSuccess(proc, JSON.stringify({ entries: [] }));

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'yt-dlp',
      expect.arrayContaining([
        'https://youtube.com/feed',
        '-J',
        '--flat-playlist',
        '--playlist-start', '1',
        '--playlist-end', '5',
        '--cookies-from-browser', 'chrome',
      ]),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  it('adds YouTube extractor args for youtube.com URLs', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = fetchFeed('https://youtube.com/feed', 3);
    emitSuccess(proc, JSON.stringify({ entries: [] }));

    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--extractor-args');
    expect(args).toContain('youtubetab:approximate_date');
  });

  it('does NOT add extractor args for tiktok.com URLs', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = fetchFeed('https://tiktok.com/@user', 3);
    emitSuccess(proc, JSON.stringify({ entries: [] }));

    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--extractor-args');
    expect(args).not.toContain('youtubetab:approximate_date');
  });

  it('uses start parameter correctly (default 1 vs custom)', async () => {
    // Default start = 1
    const proc1 = createMockProcess();
    mockSpawn.mockReturnValue(proc1);
    const p1 = fetchFeed('https://youtube.com/feed', 10);
    emitSuccess(proc1, JSON.stringify({ entries: [] }));
    await p1;

    let args = mockSpawn.mock.calls[0][1] as string[];
    const startIdx1 = args.indexOf('--playlist-start');
    expect(args[startIdx1 + 1]).toBe('1');
    const endIdx1 = args.indexOf('--playlist-end');
    expect(args[endIdx1 + 1]).toBe('10');

    // Custom start = 6
    const proc2 = createMockProcess();
    mockSpawn.mockReturnValue(proc2);
    const p2 = fetchFeed('https://youtube.com/feed', 10, 6);
    emitSuccess(proc2, JSON.stringify({ entries: [] }));
    await p2;

    args = mockSpawn.mock.calls[1][1] as string[];
    const startIdx2 = args.indexOf('--playlist-start');
    expect(args[startIdx2 + 1]).toBe('6');
    const endIdx2 = args.indexOf('--playlist-end');
    expect(args[endIdx2 + 1]).toBe('15');
  });

  it('parses JSON stdout and returns result', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const expected = { entries: [{ title: 'A' }], title: 'My Feed' };
    const promise = fetchFeed('https://youtube.com/feed', 5);
    emitSuccess(proc, JSON.stringify(expected));

    const result = await promise;
    expect(result).toEqual(expected);
  });

  it('rejects when yt-dlp exits non-zero', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = fetchFeed('https://youtube.com/feed', 5);
    emitFailure(proc, 1, 'ERROR: something went wrong');

    await expect(promise).rejects.toThrow('yt-dlp exited with code 1');
    await expect(promise).rejects.toThrow('ERROR: something went wrong');
  });

  it('rejects on spawn error event', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = fetchFeed('https://youtube.com/feed', 5);
    emitSpawnError(proc, 'ENOENT');

    await expect(promise).rejects.toThrow('Failed to spawn yt-dlp: ENOENT');
  });
});

// ---------------------------------------------------------------------------
// fetchVideoInfo
// ---------------------------------------------------------------------------
describe('fetchVideoInfo', () => {
  it('calls spawn with correct args (-J, --no-playlist, --cookies-from-browser)', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = fetchVideoInfo('https://youtube.com/watch?v=abc');
    emitSuccess(proc, JSON.stringify({ title: 'Test' }));

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'yt-dlp',
      [
        'https://youtube.com/watch?v=abc',
        '-J',
        '--no-playlist',
        '--cookies-from-browser', 'chrome',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  it('parses JSON stdout', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const expected = { title: 'My Video', duration: 300 };
    const promise = fetchVideoInfo('https://youtube.com/watch?v=xyz');
    emitSuccess(proc, JSON.stringify(expected));

    const result = await promise;
    expect(result).toEqual(expected);
  });

  it('rejects on non-zero exit code', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = fetchVideoInfo('https://youtube.com/watch?v=bad');
    emitFailure(proc, 2, 'Video not found');

    await expect(promise).rejects.toThrow('yt-dlp exited with code 2');
    await expect(promise).rejects.toThrow('Video not found');
  });

  it('rejects on spawn error', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = fetchVideoInfo('https://youtube.com/watch?v=err');
    emitSpawnError(proc, 'spawn yt-dlp ENOENT');

    await expect(promise).rejects.toThrow('Failed to spawn yt-dlp: spawn yt-dlp ENOENT');
  });
});

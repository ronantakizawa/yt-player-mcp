import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mock factories ---

function createMockSocket() {
  const socket = new EventEmitter() as any;
  socket.write = vi.fn();
  socket.end = vi.fn();
  socket.destroy = vi.fn();
  socket.setTimeout = vi.fn();
  return socket;
}

function createMockChildProcess() {
  const proc = new EventEmitter() as any;
  proc.kill = vi.fn();
  proc.unref = vi.fn();
  proc.pid = 12345;
  return proc;
}

// --- Mocks ---

let mockSocket: ReturnType<typeof createMockSocket>;
let mockProc: ReturnType<typeof createMockChildProcess>;

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('net', () => ({
  createConnection: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('./validate.js', () => ({
  getBrowser: vi.fn(() => 'chrome'),
}));

import { spawn } from 'child_process';
import { createConnection } from 'net';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import {
  cleanup,
  isPlaying,
  launch,
  getProperty,
  command,
  writeTempPlaylist,
  appendUrl,
  startAutoRefill,
  stopAutoRefill,
} from '../mpv.js';

const mockedSpawn = vi.mocked(spawn);
const mockedCreateConnection = vi.mocked(createConnection);
const mockedExistsSync = vi.mocked(existsSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);

/** Set up fresh mocks and call cleanup() to reset module state. */
function resetMocksAndState() {
  mockSocket = createMockSocket();
  mockProc = createMockChildProcess();

  mockedCreateConnection.mockReturnValue(mockSocket as any);
  mockedSpawn.mockReturnValue(mockProc as any);
  mockedExistsSync.mockReturnValue(false);
  mockedUnlinkSync.mockImplementation(() => undefined as any);

  // Reset module state
  cleanup();

  // Clear call counts after cleanup so tests only see their own calls
  vi.clearAllMocks();

  // Re-apply default mocks after clearing
  mockedCreateConnection.mockReturnValue(mockSocket as any);
  mockedSpawn.mockReturnValue(mockProc as any);
  mockedExistsSync.mockReturnValue(false);
  mockedUnlinkSync.mockImplementation(() => undefined as any);
}

beforeEach(() => {
  resetMocksAndState();
});

afterEach(() => {
  stopAutoRefill();
  cleanup();
});

// --- cleanup ---

describe('cleanup', () => {
  it('kills process with SIGTERM if it exists', async () => {
    mockedExistsSync.mockReturnValue(true);
    await launch({ url: 'https://www.youtube.com/watch?v=test' });

    cleanup();

    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('sets process to null after cleanup', async () => {
    mockedExistsSync.mockReturnValue(true);
    await launch({ url: 'https://www.youtube.com/watch?v=test' });
    expect(isPlaying()).toBe(true);

    cleanup();

    expect(isPlaying()).toBe(false);
  });

  it('calls unlinkSync on socket path', () => {
    cleanup();
    expect(mockedUnlinkSync).toHaveBeenCalled();
  });

  it('does not throw when kill or unlinkSync fails', async () => {
    mockedExistsSync.mockReturnValue(true);
    await launch({ url: 'https://www.youtube.com/watch?v=test' });

    mockProc.kill.mockImplementation(() => { throw new Error('already dead'); });
    mockedUnlinkSync.mockImplementation(() => { throw new Error('no such file'); });

    expect(() => cleanup()).not.toThrow();
  });
});

// --- isPlaying ---

describe('isPlaying', () => {
  it('returns false initially', () => {
    expect(isPlaying()).toBe(false);
  });

  it('returns true after launch', async () => {
    mockedExistsSync.mockReturnValue(true);
    await launch({ url: 'https://www.youtube.com/watch?v=test' });
    expect(isPlaying()).toBe(true);
  });
});

// --- launch ---

describe('launch', () => {
  beforeEach(() => {
    mockedExistsSync.mockReturnValue(true);
  });

  it('spawns mpv with correct base args', async () => {
    await launch({ url: 'https://www.youtube.com/watch?v=abc' });

    expect(mockedSpawn).toHaveBeenCalledWith(
      'mpv',
      expect.arrayContaining([
        expect.stringMatching(/^--input-ipc-server=/),
        '--no-terminal',
        '--ytdl',
        '--ytdl-raw-options=cookies-from-browser=chrome',
        '--prefetch-playlist',
        '--force-window',
        'https://www.youtube.com/watch?v=abc',
      ]),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('includes --no-video when audioOnly is true', async () => {
    await launch({ url: 'https://www.youtube.com/watch?v=abc', audioOnly: true });

    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--no-video');
    expect(args).not.toContain('--force-window');
  });

  it('includes --force-window when audioOnly is not set', async () => {
    await launch({ url: 'https://www.youtube.com/watch?v=abc' });

    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--force-window');
    expect(args).not.toContain('--no-video');
  });

  it('includes --shuffle when shuffle is true', async () => {
    await launch({ url: 'https://www.youtube.com/watch?v=abc', shuffle: true });

    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--shuffle');
  });

  it('includes --start=N when timestamp > 0', async () => {
    await launch({ url: 'https://www.youtube.com/watch?v=abc', timestamp: 42 });

    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--start=42');
  });

  it('includes --playlist=FILE when playlistFile is set', async () => {
    await launch({ playlistFile: '/tmp/playlist.txt' });

    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--playlist=/tmp/playlist.txt');
  });

  it('appends URL as last arg', async () => {
    await launch({ url: 'https://www.youtube.com/watch?v=abc' });

    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('calls unref() on child process', async () => {
    await launch({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(mockProc.unref).toHaveBeenCalled();
  });

  it('rejects if socket does not appear within timeout', async () => {
    vi.useFakeTimers();
    mockedExistsSync.mockReturnValue(false);

    const promise = launch({ url: 'https://www.youtube.com/watch?v=abc', socketTimeoutMs: 1000 });

    // Catch the rejection immediately to prevent unhandled rejection warning
    const caught = promise.catch((e: Error) => e);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(1200);

    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('mpv socket did not appear');

    cleanup();
    vi.useRealTimers();
  });
});

// --- sendCommand (tested via getProperty and command) ---

describe('getProperty', () => {
  it('sends get_property command and returns the data field', async () => {
    const promise = getProperty('volume');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('data', JSON.stringify({ error: 'success', data: 75 }) + '\n');
      });
    });

    const result = await promise;
    expect(result).toBe(75);
    expect(mockSocket.write).toHaveBeenCalledWith(
      JSON.stringify({ command: ['get_property', 'volume'] }) + '\n',
    );
  });

  it('returns complex data values', async () => {
    const promise = getProperty('metadata');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('data', JSON.stringify({ error: 'success', data: { title: 'Test' } }) + '\n');
      });
    });

    const result = await promise;
    expect(result).toEqual({ title: 'Test' });
  });
});

describe('command', () => {
  it('sends provided args array and resolves', async () => {
    const promise = command(['set_property', 'pause', true]);

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('data', JSON.stringify({ error: 'success' }) + '\n');
      });
    });

    const result = await promise;
    expect(result).toEqual({ error: 'success' });
    expect(mockSocket.write).toHaveBeenCalledWith(
      JSON.stringify({ command: ['set_property', 'pause', true] }) + '\n',
    );
  });
});

// --- sendCommand error handling ---

describe('sendCommand error handling', () => {
  it('resolves on success response', async () => {
    const promise = getProperty('time-pos');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('data', JSON.stringify({ error: 'success', data: 12.5 }) + '\n');
      });
    });

    await expect(promise).resolves.toBe(12.5);
  });

  it('rejects on mpv error response', async () => {
    const promise = getProperty('nonexistent');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('data', JSON.stringify({ error: 'property not found' }) + '\n');
      });
    });

    await expect(promise).rejects.toThrow('mpv error: property not found');
  });

  it('rejects on socket timeout', async () => {
    const promise = getProperty('volume');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('timeout');
      });
    });

    await expect(promise).rejects.toThrow('mpv IPC timeout');
  });

  it('rejects on socket error', async () => {
    const promise = getProperty('volume');

    process.nextTick(() => {
      mockSocket.emit('error', new Error('ECONNREFUSED'));
    });

    await expect(promise).rejects.toThrow('mpv IPC error: ECONNREFUSED. Is a video playing?');
  });

  it('rejects on empty response at end', async () => {
    const promise = getProperty('volume');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('end');
      });
    });

    await expect(promise).rejects.toThrow('No response from mpv');
  });

  it('rejects on invalid JSON at end', async () => {
    const promise = getProperty('volume');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('data', 'not-json\n');
        process.nextTick(() => {
          mockSocket.emit('end');
        });
      });
    });

    await expect(promise).rejects.toThrow('Invalid response from mpv');
  });

  it('handles event lines before response line', async () => {
    const promise = getProperty('volume');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        // mpv sends event lines (no 'error' key) before the actual response
        const event = JSON.stringify({ event: 'property-change', name: 'volume' });
        const response = JSON.stringify({ error: 'success', data: 80 });
        mockSocket.emit('data', event + '\n' + response + '\n');
      });
    });

    const result = await promise;
    expect(result).toBe(80);
  });
});

// --- writeTempPlaylist ---

describe('writeTempPlaylist', () => {
  it('writes URLs joined by newlines with trailing newline', () => {
    const urls = ['https://youtube.com/watch?v=a', 'https://youtube.com/watch?v=b'];
    writeTempPlaylist(urls);

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('mpv-mcp-shorts-'),
      'https://youtube.com/watch?v=a\nhttps://youtube.com/watch?v=b\n',
    );
  });

  it('returns a path in tmpdir', () => {
    const result = writeTempPlaylist(['https://youtube.com/watch?v=a']);
    expect(result).toContain(tmpdir());
    expect(result).toContain('mpv-mcp-shorts-');
  });
});

// --- appendUrl ---

describe('appendUrl', () => {
  it('sends loadfile append command', async () => {
    const promise = appendUrl('https://www.youtube.com/watch?v=xyz');

    process.nextTick(() => {
      mockSocket.emit('connect');
      process.nextTick(() => {
        mockSocket.emit('data', JSON.stringify({ error: 'success' }) + '\n');
      });
    });

    await promise;

    expect(mockSocket.write).toHaveBeenCalledWith(
      JSON.stringify({ command: ['loadfile', 'https://www.youtube.com/watch?v=xyz', 'append'] }) + '\n',
    );
  });
});

// --- Auto-refill ---

describe('startAutoRefill / stopAutoRefill', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // Need a "running" mpv process
    mockedExistsSync.mockReturnValue(true);
    await launch({ url: 'https://www.youtube.com/watch?v=test' });
  });

  afterEach(() => {
    stopAutoRefill();
    vi.useRealTimers();
  });

  it('stopAutoRefill clears interval and resets state', async () => {
    const fetchMore = vi.fn().mockResolvedValue([]);
    startAutoRefill(10, fetchMore);

    stopAutoRefill();

    // Advancing time should not trigger any fetch
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMore).not.toHaveBeenCalled();
  });

  it('fetches more when remaining <= 3', async () => {
    const newUrls = ['https://youtube.com/watch?v=new1', 'https://youtube.com/watch?v=new2'];
    const fetchMore = vi.fn().mockResolvedValue(newUrls);

    // Mock getProperty calls: playlist-pos=7, playlist-count=10 => remaining=2
    let callCount = 0;
    mockedCreateConnection.mockImplementation(() => {
      const sock = createMockSocket();
      process.nextTick(() => {
        sock.emit('connect');
        process.nextTick(() => {
          callCount++;
          if (callCount === 1) {
            sock.emit('data', JSON.stringify({ error: 'success', data: 7 }) + '\n');
          } else if (callCount === 2) {
            sock.emit('data', JSON.stringify({ error: 'success', data: 10 }) + '\n');
          } else {
            // appendUrl calls
            sock.emit('data', JSON.stringify({ error: 'success' }) + '\n');
          }
        });
      });
      return sock as any;
    });

    startAutoRefill(10, fetchMore);

    // Advance one interval tick
    await vi.advanceTimersByTimeAsync(5_000);
    // Flush microtasks for the async interval callback
    await new Promise(r => process.nextTick(r));
    await new Promise(r => process.nextTick(r));
    await new Promise(r => process.nextTick(r));

    // Stop to prevent further interval ticks
    stopAutoRefill();

    expect(fetchMore).toHaveBeenCalledWith(10, 15);
  });

  it('appends returned URLs via loadfile append', async () => {
    const newUrls = ['https://youtube.com/watch?v=a'];
    const fetchMore = vi.fn().mockResolvedValue(newUrls);

    const writtenCommands: string[] = [];
    let callCount = 0;
    mockedCreateConnection.mockImplementation(() => {
      const sock = createMockSocket();
      sock.write.mockImplementation((data: string) => {
        writtenCommands.push(data);
      });
      process.nextTick(() => {
        sock.emit('connect');
        process.nextTick(() => {
          callCount++;
          if (callCount <= 2) {
            // getProperty calls: pos=8, count=10 => remaining=1
            const val = callCount === 1 ? 8 : 10;
            sock.emit('data', JSON.stringify({ error: 'success', data: val }) + '\n');
          } else {
            sock.emit('data', JSON.stringify({ error: 'success' }) + '\n');
          }
        });
      });
      return sock as any;
    });

    startAutoRefill(5, fetchMore);

    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise(r => process.nextTick(r));
    await new Promise(r => process.nextTick(r));
    await new Promise(r => process.nextTick(r));
    await new Promise(r => process.nextTick(r));

    stopAutoRefill();

    // Check that loadfile append was sent
    const appendCalls = writtenCommands.filter(c => c.includes('loadfile'));
    expect(appendCalls.length).toBeGreaterThanOrEqual(1);
    expect(appendCalls[0]).toContain('"loadfile"');
    expect(appendCalls[0]).toContain('"append"');
  });

  it('stops when fetchMore returns empty array', async () => {
    const fetchMore = vi.fn().mockResolvedValue([]);

    let callCount = 0;
    mockedCreateConnection.mockImplementation(() => {
      const sock = createMockSocket();
      process.nextTick(() => {
        sock.emit('connect');
        process.nextTick(() => {
          callCount++;
          if (callCount === 1) {
            sock.emit('data', JSON.stringify({ error: 'success', data: 9 }) + '\n');
          } else {
            sock.emit('data', JSON.stringify({ error: 'success', data: 10 }) + '\n');
          }
        });
      });
      return sock as any;
    });

    startAutoRefill(10, fetchMore);
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise(r => process.nextTick(r));
    await new Promise(r => process.nextTick(r));
    await new Promise(r => process.nextTick(r));

    expect(fetchMore).toHaveBeenCalled();

    // Reset and advance again — should not call fetchMore again since auto-refill stopped
    fetchMore.mockClear();
    callCount = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMore).not.toHaveBeenCalled();
  });

  it('stops on IPC error', async () => {
    const fetchMore = vi.fn().mockResolvedValue(['url']);

    mockedCreateConnection.mockImplementation(() => {
      const sock = createMockSocket();
      process.nextTick(() => {
        sock.emit('error', new Error('connection refused'));
      });
      return sock as any;
    });

    startAutoRefill(10, fetchMore);
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise(r => process.nextTick(r));
    await new Promise(r => process.nextTick(r));

    // After error, auto-refill should have stopped
    fetchMore.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMore).not.toHaveBeenCalled();
  });
});

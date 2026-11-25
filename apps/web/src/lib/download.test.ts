import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiRequestError } from './api';
import { downloadFile, filenameFromDisposition } from './download';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('filenameFromDisposition', () => {
  it('reads quoted, bare and RFC 5987 names', () => {
    expect(filenameFromDisposition('attachment; filename="timesheet-a.csv"', 'x.csv')).toBe(
      'timesheet-a.csv',
    );
    expect(filenameFromDisposition('attachment; filename=t.csv', 'x.csv')).toBe('t.csv');
    expect(
      filenameFromDisposition(
        `attachment; filename="plain.csv"; filename*=UTF-8''caf%C3%A9.csv`,
        'x.csv',
      ),
    ).toBe('café.csv');
  });

  it('falls back when missing', () => {
    expect(filenameFromDisposition(null, 'x.csv')).toBe('x.csv');
    expect(filenameFromDisposition('attachment', 'x.csv')).toBe('x.csv');
  });
});

describe('downloadFile (review gap 8)', () => {
  it('throws the API error (message, not raw JSON) and never starts a download', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { statusCode: 403, code: 'FORBIDDEN', message: "You don't have permission to do that" },
            { status: 403 },
          ),
        ),
    );
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const err: unknown = await downloadFile('/api/timesheets/export.csv?x', 'x.csv').catch(
      (e: unknown) => e,
    );
    expect(isApiRequestError(err)).toBe(true);
    expect((err as Error).message).toBe("You don't have permission to do that");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

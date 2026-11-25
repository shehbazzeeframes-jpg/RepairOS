import { describe, expect, it, vi } from 'vitest';
import { processJob, redisConnection } from './jobs';

describe('worker jobs', () => {
  it('parses REDIS_URL', () => {
    expect(redisConnection('redis://:s3cret@redis.internal:6380/2')).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      password: 's3cret',
      db: 2,
      maxRetriesPerRequest: null,
    });
  });

  it('answers ping and rejects unknown jobs', async () => {
    const logger = { info: vi.fn() };
    await expect(processJob({ id: '1', name: 'ping', data: {} }, logger)).resolves.toEqual({ pong: true });
    await expect(processJob({ id: '2', name: 'nope', data: {} }, logger)).rejects.toThrow(/No processor/);
  });
});

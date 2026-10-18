import {
  parseWorkerStatus,
  toWorkerStatusView,
  writeWorkerStatus,
  YSOCIAL_WORKER_STATUS_KEY,
  YSOCIAL_WORKER_STATUS_TTL_S,
  YsocialWorkerStatusRecord,
} from './worker.status';

const record: YsocialWorkerStatusRecord = {
  state: 'running',
  namespace: 'ysocial',
  taskQueue: 'ysocial-postiz',
  since: '2026-10-19T07:00:00.000Z',
  updatedAt: '2026-10-19T07:00:30.000Z',
  version: '0.2.0',
};

describe('worker status', () => {
  it('writes the record with an expiry', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    await writeWorkerStatus({ get: jest.fn(), set }, record);
    expect(set).toHaveBeenCalledWith(
      YSOCIAL_WORKER_STATUS_KEY,
      JSON.stringify(record),
      'EX',
      YSOCIAL_WORKER_STATUS_TTL_S
    );
  });

  it('parses only valid records', () => {
    expect(parseWorkerStatus(JSON.stringify(record))).toEqual(record);
    expect(parseWorkerStatus(undefined)).toBeUndefined();
    expect(parseWorkerStatus('')).toBeUndefined();
    expect(parseWorkerStatus('{')).toBeUndefined();
    expect(parseWorkerStatus('{"state":"other"}')).toBeUndefined();
  });

  it('shows "Worker an" only while running', () => {
    expect(toWorkerStatusView(record, 'x')).toMatchObject({
      running: true,
      label: 'Worker an',
      state: 'running',
      namespace: 'ysocial',
    });
    expect(
      toWorkerStatusView({ ...record, state: 'error', reason: 'kaputt' }, 'x')
    ).toMatchObject({ running: false, label: 'Worker aus', reason: 'kaputt' });
    expect(
      toWorkerStatusView({ ...record, state: 'starting' }, 'x')
    ).toMatchObject({ running: false, label: 'Worker aus' });
  });

  it('shows "Worker aus" with the fallback reason without a record', () => {
    expect(toWorkerStatusView(undefined, 'HUB_INTERNAL_TOKEN fehlt')).toEqual({
      running: false,
      label: 'Worker aus',
      state: 'unknown',
      reason: 'HUB_INTERNAL_TOKEN fehlt',
    });
  });
});

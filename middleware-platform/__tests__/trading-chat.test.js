'use strict';

const request = require('supertest');
const app = require('../server');

describe('trading chat API', () => {
  it('POST /api/trading/chat/turn returns 501 when agent disabled', async () => {
    const prev = process.env.TRADING_AGENT_ENABLED;
    delete process.env.TRADING_AGENT_ENABLED;
    const res = await request(app)
      .post('/api/trading/chat/turn')
      .send({ message: 'MRNA news?' });
    if (prev) process.env.TRADING_AGENT_ENABLED = prev;
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/not implemented/i);
  });
});

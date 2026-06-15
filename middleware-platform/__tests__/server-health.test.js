'use strict';

const request = require('supertest');
const app = require('../server');

describe('server health', () => {
  it('GET /health returns somo-trading', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.product).toBe('somo-trading');
    expect(res.body.mode).toBeDefined();
  });
});

import { describe, expect, it } from 'vitest';

import { patientDispatcher, patientFetchInit } from './patience.js';

describe('patientDispatcher', () => {
  it('builds an agent from the runtime that fetch itself uses', async () => {
    // Node creates its global dispatcher lazily, so nothing exists to copy
    // until a request has gone out.
    await fetch('http://127.0.0.1:1/').catch(() => {});

    expect(patientDispatcher()).toBeDefined();
  });

  it('is spread into a fetch init', () => {
    expect(patientFetchInit()).toHaveProperty('dispatcher');
  });

  it('answers the same agent every time', () => {
    // One agent, one connection pool. A fresh agent per request would open a
    // new socket for every job and leak them.
    expect(patientDispatcher()).toBe(patientDispatcher());
  });
});

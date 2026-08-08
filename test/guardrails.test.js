const { checkGuardrails } = require('../src/guardrails');

describe('checkGuardrails - maxQueryLength', () => {
  it('allows a query at or under the limit', () => {
    expect(() => checkGuardrails('a'.repeat(2000), { maxQueryLength: 2000 })).not.toThrow();
  });

  it('rejects a query over the limit', () => {
    expect(() => checkGuardrails('a'.repeat(2001), { maxQueryLength: 2000 }))
      .toThrow('GuardrailViolation: query exceeds maxQueryLength');
  });

  it('does nothing when maxQueryLength is not set', () => {
    expect(() => checkGuardrails('a'.repeat(100000), {})).not.toThrow();
  });
});

describe('checkGuardrails - blockPii', () => {
  it('allows an ordinary query when blockPii is off', () => {
    expect(() => checkGuardrails('contact me at john@example.com', { blockPii: false })).not.toThrow();
  });

  it('rejects a query containing an email address when blockPii is on', () => {
    expect(() => checkGuardrails('contact me at john@example.com', { blockPii: true }))
      .toThrow('GuardrailViolation: possible PII detected');
  });

  it('rejects a query containing a phone number when blockPii is on', () => {
    expect(() => checkGuardrails('call me at 555-123-4567', { blockPii: true }))
      .toThrow('GuardrailViolation: possible PII detected');
  });

  it('rejects a query containing an SSN-shaped number when blockPii is on', () => {
    expect(() => checkGuardrails('my ssn is 123-45-6789', { blockPii: true }))
      .toThrow('GuardrailViolation: possible PII detected');
  });

  it('rejects a query containing a long digit run (credit-card-shaped) when blockPii is on', () => {
    expect(() => checkGuardrails('card number 4111111111111111', { blockPii: true }))
      .toThrow('GuardrailViolation: possible PII detected');
  });

  it('allows a query with no PII when blockPii is on', () => {
    expect(() => checkGuardrails('what is the refund policy?', { blockPii: true })).not.toThrow();
  });

  it('does nothing when guardrailsConfig is undefined', () => {
    expect(() => checkGuardrails('anything', undefined)).not.toThrow();
  });
});

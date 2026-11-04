import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/web/evaluation.ts';

const criterion = (keywords, weight = 20) => ({ id: 'test', label: 'Test', weight, keywords });
test('la valutazione riporta solo evidenze letterali e non trova sottostringhe', () => {
  const [result] = evaluate('Il piano operativo è pronto. Abbiamo certificazioni ISO!', [criterion('piano operativo, ISO, piano economico, pia')]);
  assert.deepEqual(result.matched, ['piano operativo', 'ISO']);
  assert.deepEqual(result.missing, ['piano economico', 'pia']);
  assert.deepEqual(result.evidence, ['Il piano operativo è pronto.', 'Abbiamo certificazioni ISO!']);
  assert.equal(result.score, 10);
});
test('criteri vuoti o pesi non validi non producono punteggi positivi', () => {
  assert.equal(evaluate('test', [criterion(' , ', 20)])[0].score, 0);
  assert.equal(evaluate('test', [criterion('test', -1)])[0].score, 0);
});
test('le frasi chiave rispettano i confini delle parole e le frasi del testo', () => {
  const [result] = evaluate('Formazione del personale. Piano operativo efficace.', [criterion('personale, formazione del personale, personale piano, piano operativo')]);
  assert.deepEqual(result.matched, ['personale', 'formazione del personale', 'piano operativo']);
  assert.deepEqual(result.missing, ['personale piano']);
  assert.equal(result.evidence.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnac } from '../src/web/anac.ts';

test('raggruppa per CIG e non inventa regione o dati assenti', () => {
  const rows = normalizeAnac([{CIG:'BAEA6A55C3', oggetto_lotto:'Test', denominazione_amministrazione_appaltante:'Ente', cod_cpv:'45000000', importo_lotto:'1.234,56', data_scadenza_offerta:'31/12/2026'}, {cig:'BAEA6A55C3', oggetto_lotto:'Test', cod_cpv:'45100000'}, {cig:'invalido', oggetto_lotto:'Da scartare'}]);
  assert.equal(rows.length,1); assert.equal(rows[0].cpv,'45000000, 45100000'); assert.equal(rows[0].estimated_value,1234.56); assert.equal(rows[0].deadline,'2026-12-31'); assert.equal(rows[0].region,''); assert.equal(rows[0].official_url,null);
});
test('importi ambigui e date impossibili non vengono inventati', () => {
  const [row] = normalizeAnac([{cig:'BAEA6A55C3',oggetto_gara:'Test',importo_lotto:'1.234',data_scadenza_offerta:'31/02/2026'}]);
  assert.equal(row.estimated_value,null); assert.equal(row.deadline,null);
});

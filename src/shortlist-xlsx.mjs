import readXlsxFile from 'read-excel-file/node';
import { validateXlsxArchive } from './parse.mjs';

const norm = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const idNorm = value => norm(value).replace(/[\s-]/g, '');
const emailHeader = /^(?:primary\s+|alternate\s+|university\s+|student\s+)?(?:e-?mail)(?:\s+(?:address|id))?$/i;
const registrationHeader = /^(?:student\s+)?(?:roll\s*(?:no|number)?|registration\s*(?:no|number|id)?)$/i;
const nameHeader = /^(?:(?:candidate|student|full)\s+)?name$/i;

export async function parseShortlistWorkbook(bytes) {
  validateXlsxArchive(bytes);
  let sheets;
  try { sheets = await readXlsxFile(bytes); }
  catch { throw Object.assign(new Error('XLSX could not be parsed'), { code: 'CORRUPT_XLSX' }); }
  if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > 10) throw Object.assign(new Error('XLSX sheet limit exceeded'), { code: 'XLSX_LIMIT' });
  return sheets.map(sheet => {
    if (!Array.isArray(sheet.data) || sheet.data.length > 10_000 || sheet.data.some(row => !Array.isArray(row) || row.length > 50)) throw Object.assign(new Error('XLSX row or column limit exceeded'), { code: 'XLSX_LIMIT' });
    let headers = null;
    for (let i = 0; i < Math.min(sheet.data.length, 10); i++) {
      const row = sheet.data[i];
      const email = [], registration = [], name = [];
      row.forEach((value, col) => {
        const label = norm(value);
        if (emailHeader.test(label)) email.push(col);
        if (registrationHeader.test(label)) registration.push(col);
        if (nameHeader.test(label)) name.push(col);
      });
      if (email.length || registration.length) { headers = { row: i + 1, email, registration, name }; break; }
    }
    return { name: String(sheet.sheet).slice(0, 100), rows: sheet.data, headers };
  });
}

export function matchStudentInWorkbook(sheets, profile, { exhaustive = false } = {}) {
  const email = norm(profile.universityEmail);
  const ids = new Set((profile.registrationIds ?? []).map(idNorm));
  const names = new Set([profile.fullName, ...(profile.nameVariants ?? [])].filter(Boolean).map(norm));
  const exact = [], nameOnly = []; let exactCount = 0;
  let hasIdentifierColumn = false;
  for (const sheet of sheets) {
    const h = sheet.headers;
    if (!h) continue;
    hasIdentifierColumn = true;
    for (let i = h.row; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      const matchedEmail = h.email.filter(col => norm(row[col]) === email);
      const matchedId = h.registration.filter(col => ids.has(idNorm(row[col])) && idNorm(row[col]));
      const matchedName = h.name.filter(col => names.has(norm(row[col])) && norm(row[col]));
      const evidence = { sheet: sheet.name, row: i + 1,
        columns: [...matchedEmail.map(col => ({ index: col + 1, type: 'university_email' })),
          ...matchedId.map(col => ({ index: col + 1, type: 'registration_id' }))],
        nameSupported: matchedName.length > 0 };
      if (matchedEmail.length || matchedId.length) {
        const conflictingEmail = matchedId.length && h.email.some(col => row[col] && norm(row[col]) !== email);
        const conflictingId = matchedEmail.length && ids.size && h.registration.some(col => row[col] && !ids.has(idNorm(row[col])));
        exactCount++;
        if (exact.length < 3) exact.push({ ...evidence, conflictingIdentifier: Boolean(conflictingEmail || conflictingId) });
      } else if (matchedName.length && nameOnly.length < 3) nameOnly.push({ sheet: sheet.name, row: i + 1, nameColumn: matchedName[0] + 1 });
    }
  }
  if (exactCount > 1 || exact.some(row => row.conflictingIdentifier)) return { outcome: 'needs_review', reason: 'duplicate_or_conflicting_identity', matches: exact, matchCount: exactCount };
  if (exact.length === 1) return { outcome: 'shortlisted', identifierType: exact[0].columns[0].type, matches: exact };
  if (nameOnly.length) return { outcome: 'needs_review', reason: 'name_without_verified_identifier', matches: [], nameOnlyLocations: nameOnly.slice(0, 3) };
  if (!hasIdentifierColumn) return { outcome: 'unknown', reason: 'no_identifier_columns', matches: [] };
  return { outcome: exhaustive ? 'not_listed' : 'unknown', reason: exhaustive ? 'absent_from_exhaustive_list' : 'list_completeness_unverified', matches: [] };
}

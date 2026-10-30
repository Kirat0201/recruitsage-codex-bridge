import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR } from './store.mjs';
import { gmailClient } from './gmail-http.mjs';
import { normalizeAccountId } from './gmail-auth.mjs';

const ROOT = path.join(DATA_DIR, 'identity');
const schema = z.object({
  accountId: z.email(), universityEmail: z.email(),
  fullName: z.string().max(120).optional(),
  nameVariants: z.array(z.string().min(2).max(120)).max(10).default([]),
  registrationIds: z.array(z.string().min(4).max(60)).max(10).default([]),
}).strict();
const fileFor = (accountId, root = ROOT) => path.join(root, `${createHash('sha256').update(normalizeAccountId(accountId)).digest('hex')}.json`);

export async function loadStudentIdentity(accountId, { root = ROOT } = {}) {
  const file = fileFor(accountId, root);
  let handle;
  try {
    handle = await open(file, 'r');
    if ((await handle.stat()).mode & 0o077) throw new Error('Student identity file must be owner-only');
    const profile = schema.parse(JSON.parse(await handle.readFile('utf8')));
    if (normalizeAccountId(profile.accountId) !== normalizeAccountId(accountId)) throw new Error('Student identity account mismatch');
    return profile;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

export async function saveStudentIdentity(profile, { root = ROOT } = {}) {
  const value = schema.parse(profile);
  if (normalizeAccountId(value.accountId) !== normalizeAccountId(value.universityEmail)) throw new Error('Verified Gmail identity must match account');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = fileFor(value.accountId, root), temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  return { configured: true, accountId: normalizeAccountId(value.accountId), hasEmail: true,
    hasName: Boolean(value.fullName), nameVariants: value.nameVariants.length, registrationIds: value.registrationIds.length };
}

export async function configureIdentityFromGmail(accountId, { client = gmailClient, root = ROOT } = {}) {
  accountId = normalizeAccountId(accountId);
  const profile = await client.profile(accountId);
  if (normalizeAccountId(profile.emailAddress) !== accountId) throw new Error('Gmail profile does not match requested identity');
  const prior = await loadStudentIdentity(accountId, { root });
  return saveStudentIdentity({ accountId, universityEmail: accountId,
    fullName: prior?.fullName, nameVariants: prior?.nameVariants ?? [], registrationIds: prior?.registrationIds ?? [] }, { root });
}

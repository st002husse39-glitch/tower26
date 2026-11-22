import test, { after, before, beforeEach } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

const projectId = 'demo-tower26-rules-tests';
let env;

const seedData = {
  'users/resident-a': { role: 'user', unit: '101' },
  'users/resident-b': { role: 'user', unit: '202' },
  'users/admin-a': { role: 'admin', unit: 'ADM' },
  'users/super-a': { role: 'superadmin' },
  'polls/p-open': { q: 'Vote?', options: ['Yes', 'No'], open: true, ts: 1 },
  'polls/p-closed': { q: 'Closed?', options: ['Yes', 'No'], open: false, ts: 1 },
  'votes/p-open_resident-b': { poll: 'p-open', uid: 'resident-b', unit: '202', choice: 1 },
  'requests/existing': {
    title: 'Elevator', body: 'Needs inspection', uid: 'resident-a', unit: '101',
    status: 'new', date: '2026-11-22', ts: 1
  },
  'dues/due-a': { unit: '101', status: 'unpaid', amount: 100, month: '2026-11' }
};

async function seed() {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [path, value] of Object.entries(seedData)) {
      await setDoc(doc(db, ...path.split('/')), value);
    }
  });
}

function dbFor(uid) {
  return env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore();
}

before(async () => {
  env = await initializeTestEnvironment({ projectId });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await seed();
});

test('resident maintenance requests must belong to the authenticated profile unit', async () => {
  const db = dbFor('resident-a');
  const valid = {
    title: 'Elevator issue', body: 'The elevator is noisy', uid: 'resident-a',
    unit: '101', status: 'new', date: '2026-11-22', ts: 100
  };
  await assertSucceeds(setDoc(doc(db, 'requests', 'req-valid'), valid));
  await assertFails(setDoc(doc(db, 'requests', 'req-spoofed-unit'), { ...valid, unit: '202' }));
  await assertFails(setDoc(doc(db, 'requests', 'req-spoofed-user'), { ...valid, uid: 'resident-b' }));
});

test('administrators can change a request status but not rewrite its content', async () => {
  const db = dbFor('admin-a');
  await assertSucceeds(updateDoc(doc(db, 'requests', 'existing'), { status: 'prog' }));
  await assertFails(updateDoc(doc(db, 'requests', 'existing'), { title: 'Rewritten request' }));
});

test('authenticated members can read all votes to preserve public result visibility', async () => {
  const db = dbFor('resident-a');
  const result = await assertSucceeds(getDocs(collection(db, 'votes')));
  if (result.size !== 1) throw new Error(`Expected one visible ballot, got ${result.size}`);
});

test('a vote can only be cast by the member for an open poll and valid option', async () => {
  const db = dbFor('resident-a');
  const ownVote = { poll: 'p-open', uid: 'resident-a', unit: '101', choice: 0 };
  await assertFails(setDoc(doc(db, 'votes', 'p-open_resident-a'), { ...ownVote, unit: '202' }));
  await assertSucceeds(setDoc(doc(db, 'votes', 'p-open_resident-a'), ownVote));
  await assertFails(setDoc(doc(db, 'votes', 'p-open_resident-b2'), { ...ownVote, uid: 'resident-b' }));
  await assertFails(setDoc(doc(db, 'votes', 'p-open_resident-a2'), { ...ownVote, choice: 2 }));
  await assertFails(setDoc(doc(db, 'votes', 'p-closed_resident-a'), { ...ownVote, poll: 'p-closed' }));
  await assertFails(updateDoc(doc(db, 'votes', 'p-open_resident-a'), { choice: 1 }));
});

test('resident order creation is limited to their own unit and a typed draft shape', async () => {
  const db = dbFor('resident-a');
  const order = {
    pid: 'project-1', pname: 'Elevator repair', unit: '101', kind: 'base',
    items: [{ n: 'Repair', p: 100, q: 1 }], total: 100, status: 'draft', ts: 100
  };
  await assertSucceeds(setDoc(doc(db, 'orders', 'project-1_101'), order));
  await assertFails(setDoc(doc(db, 'orders', 'project-1_202'), { ...order, unit: '202' }));
});

test('manual review workflow remains: amount can be edited in draft, but not after submission', async () => {
  const resident = dbFor('resident-a');
  const orderRef = doc(resident, 'orders', 'project-1_101');
  await assertSucceeds(setDoc(orderRef, {
    pid: 'project-1', pname: 'Elevator repair', unit: '101', kind: 'base',
    items: [{ n: 'Repair', p: 100, q: 1 }], total: 100, status: 'draft', ts: 100
  }));
  // Totals remain client-supplied under the selected temporary manual-review policy.
  await assertSucceeds(updateDoc(orderRef, {
    items: [{ n: 'Repair', p: 100, q: 1 }], total: 75, status: 'draft'
  }));
  await assertSucceeds(updateDoc(orderRef, {
    items: [{ n: 'Repair', p: 100, q: 1 }], total: 75,
    status: 'pending', receipt: 'data:image/jpeg;base64,AA=='
  }));
  await assertFails(updateDoc(orderRef, { total: 1 }));
  await assertSucceeds(updateDoc(doc(dbFor('admin-a'), 'orders', 'project-1_101'), { status: 'paid' }));
});

test('receipt uploads respect the current 800,000-character limit', async () => {
  const db = dbFor('resident-a');
  const dueRef = doc(db, 'dues', 'due-a');
  await assertSucceeds(updateDoc(dueRef, {
    status: 'pending', receipt: 'x'.repeat(800000)
  }));
  await assertFails(updateDoc(dueRef, {
    status: 'pending', receipt: 'x'.repeat(800001)
  }));

  const admin = dbFor('admin-a');
  const expense = {
    title: 'Maintenance', amount: 100, description: '', spentAt: '2026-11-22',
    status: 'pending', createdBy: 'admin-a', createdAt: 1, receipt: 'x'.repeat(800000)
  };
  await assertSucceeds(setDoc(doc(admin, 'expenses', 'expense-valid'), expense));
  await assertFails(setDoc(doc(admin, 'expenses', 'expense-too-large'), {
    ...expense, receipt: 'x'.repeat(800001)
  }));
});

test('residents can access only the application payment settings document', async () => {
  const admin = dbFor('admin-a');
  await assertSucceeds(setDoc(doc(admin, 'settings', 'pay'), { text: 'Payment details' }));
  await assertFails(setDoc(doc(admin, 'settings', 'internal'), { text: 'Internal' }));

  const resident = dbFor('resident-a');
  await assertSucceeds(getDoc(doc(resident, 'settings', 'pay')));
  await assertFails(getDoc(doc(resident, 'settings', 'internal')));
});

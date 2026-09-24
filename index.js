/**
 * Score aggregation — runs server-side, not trusted to the client.
 *
 * Why this exists: the participant app writes individual
 * `boulderCompletions` docs, but never touches `groups/{id}.totalScore`
 * directly (Firestore rules block that). These triggers are the only
 * thing allowed to update totals, which is what makes self-report safe
 * against a participant editing values in browser devtools — they can
 * report a completion happened, but can't set what it's worth.
 *
 * SETUP:
 *   npm install -g firebase-tools
 *   firebase init functions   (choose this project, Node 18+)
 *   copy this file over the generated functions/index.js
 *   firebase deploy --only functions
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

async function recomputeGroupTotal(groupId) {
  const [completionsSnap, checkpointsSnap, adjustmentsSnap] = await Promise.all([
    db.collection("boulderCompletions").where("groupId", "==", groupId).get(),
    db.collection("checkpointScores").where("groupId", "==", groupId).get(),
    db.collection("scoreAdjustments").where("groupId", "==", groupId).get(),
  ]);

  let total = 0;
  completionsSnap.forEach(d => total += (d.data().points || 0));
  checkpointsSnap.forEach(d => total += (d.data().points || 0));
  adjustmentsSnap.forEach(d => total += (d.data().delta || 0));

  const groupRef = db.collection("groups").doc(groupId);
  await groupRef.update({ totalScore: total });

  // Also bump the house total. Simplest correct approach at this scale
  // (400 groups) is recomputing the house sum from its groups, not
  // incrementing — incrementing risks drift if any write is ever
  // retried or double-applied. Recompute is a few hundred reads,
  // trivial for a Cloud Function.
  const groupSnap = await groupRef.get();
  const houseId = groupSnap.data().houseId;
  if (houseId) {
    await recomputeHouseTotal(houseId);
  }
}

async function recomputeHouseTotal(houseId) {
  const groupsSnap = await db.collection("groups").where("houseId", "==", houseId).get();
  let houseTotal = 0;
  groupsSnap.forEach(d => houseTotal += (d.data().totalScore || 0));
  await db.collection("houses").doc(houseId).update({ totalScore: houseTotal });
}

exports.onBoulderCompletion = onDocumentCreated(
  "boulderCompletions/{docId}",
  async (event) => {
    const { groupId } = event.data.data();
    await recomputeGroupTotal(groupId);
  }
);

exports.onCheckpointScore = onDocumentCreated(
  "checkpointScores/{docId}",
  async (event) => {
    const { groupId } = event.data.data();
    await recomputeGroupTotal(groupId);
  }
);

exports.onScoreAdjustment = onDocumentCreated(
  "scoreAdjustments/{docId}",
  async (event) => {
    const { groupId } = event.data.data();
    await recomputeGroupTotal(groupId);
  }
);

/*
 * NOT YET BUILT — flagging rather than skipping silently:
 *   - Sheet sync (push totals to Google Sheet + pull back flagged
 *     adjustment cells). This needs the Google Sheets API + a service
 *     account, and the conflict rule we agreed on (Sheet edit wins
 *     for flagged rows). Separate function, next step.
 *   - Game master auth (currently any client can write checkpointScores).
 *   - Points validation against config/boulders (currently trusts the
 *     client's `points` field shape, not its value).
 */

# Firestore Security Specification

## Data Invariants
1. A `Match` must have valid teams, league, sport, and date.
2. An `Analysis` must refer to a valid `matchId` and have a prediction.
3. Users can only modify their own user document.
4. Matches and Analyses are "Global Cache" - any authenticated user can read them. To prevent abuse, they can only be created by verified users.

## The "Dirty Dozen" Payloads
1. Create a Match with an invalid ID (1KB long).
2. Create an Analysis with a probability of 150 (max 100).
3. Update a Match's `homeTeam` field (Matches should be immutable after creation).
4. Create a Match as an unauthenticated user.
5. Create a User document for a different UID.
6. Update a Analysis with a "Ghost Field" `isVerified: true`.
7. Create a Match with a future `createdAt` timestamp (not matching `request.time`).
8. Create a User document without a verified email (if the rules require it).
9. Delete a Match (Matches should not be deletable by standard users).
10. Update a Match's `isHighlight` field to an invalid type (string instead of boolean).
11. Inject malicious regex or scripts into `source` field.
12. Create an Analysis for a match that doesn't exist (relational check).

## The Test Runner (firestore.rules.test.ts)
```typescript
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "gen-lang-client-0368694418",
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// Mock Auth
const alice = { uid: "alice", email: "alice@example.com", email_verified: true };
const bob = { uid: "bob", email: "bob@example.com", email_verified: true };
const unverifiedAlice = { uid: "alice", email: "alice@example.com", email_verified: false };

describe("Global Match Cache", () => {
  it("allows verified users to create a match", async () => {
    const db = testEnv.authenticatedContext(alice.uid, { email_verified: true }).firestore();
    await assertSucceeds(setDoc(doc(db, "matches", "match_1"), {
      id: "match_1",
      homeTeam: "Team A",
      awayTeam: "Team B",
      league: "League X",
      time: "20:00",
      date: "2024-05-18",
      source: "SofaScore",
      sport: "Futebol",
      isHighlight: true,
      createdAt: new Date().toISOString() // Note: In actual rules we use serverTimestamp
    }));
  });

  it("denies unauthenticated users to create a match", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, "matches", "match_1"), { homeTeam: "A" }));
  });
});
```

*(Note: Simplified test runner for specification purposes)*

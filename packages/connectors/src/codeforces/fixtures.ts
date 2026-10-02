/** Synthetic API fixture: public fields only, no source code or real member names. */
export function submissionFixture(id = 100, overrides: Record<string, unknown> = {}) {
  return {
    id, contestId: 566, creationTimeSeconds: 1700000000 + id, relativeTimeSeconds: id,
    problem: { contestId: 566, index: 'A', name: 'Fixture problem', type: 'PROGRAMMING', rating: 1200, tags: ['implementation'] },
    author: { members: [{ handle: 'ExampleUser' }], participantType: 'PRACTICE', ghost: false },
    verdict: 'OK', programmingLanguage: 'GNU C++20', testset: 'TESTS', passedTestCount: 10,
    timeConsumedMillis: 31, memoryConsumedBytes: 1024, ...overrides,
  };
}

// Draft form: retained by repository as long as the app is open (05 "Commit").
import { beforeEach, describe, expect, it } from 'vitest';
import { setup } from '../../wt/__tests__/helpers';
import { commitForm } from '../form-state.svelte';

beforeEach(() => {
  setup();
});

describe("draft by repository", () => {
  it("each restitory keeps its summary, description and merge; return find them", () => {
    commitForm.activate('/repo/a');
    commitForm.summary = "Executive summary A";
    commitForm.body = 'corps A';
    commitForm.activate('/repo/b');
    expect(commitForm.summary).toBe('');
    commitForm.summary = "Executive summary B";
    commitForm.prefillMerge('feature');
    expect(commitForm.mergeSummary).toBe("Merge branch 'feature'");
    commitForm.activate('/repo/a');
    expect(commitForm.summary).toBe("Executive summary A");
    expect(commitForm.body).toBe('corps A');
    expect(commitForm.mergeSummary).toBe('');
    commitForm.activate('/repo/b');
    expect(commitForm.summary).toBe("Executive summary B");
    expect(commitForm.mergeSummary).toBe("Merge branch 'feature'");
  });

  it("pre-filling of the merge does not overwrite one seizure, but another merge starts again from zero", () => {
    commitForm.prefillMerge('feature');
    commitForm.mergeSummary = "Merge branch 'feature' (modified)";
    commitForm.prefillMerge('feature');
    expect(commitForm.mergeSummary).toBe("Merge branch 'feature' (modified)");
    commitForm.resetMerge();
    commitForm.prefillMerge("other");
    expect(commitForm.mergeSummary).toBe("Merge branch 'other'");
  });

  it("mergeMessage: summary + description, null if empty (the base then takes its default message)", () => {
    expect(commitForm.mergeMessage()).toBeNull();
    commitForm.mergeSummary = 'Merge x';
    commitForm.mergeBody = "Details";
    expect(commitForm.mergeMessage()).toBe("Merge x\n\nDetails");
  });
});

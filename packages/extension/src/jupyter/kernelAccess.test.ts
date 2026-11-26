import { describe, expect, it } from 'vitest';
import { canRequestKernelService } from './kernelAccess.js';

describe('canRequestKernelService', () => {
  it('never requests the Kernel API from the idle-guard path', () => {
    // The Jupyter extension shows an error message for every call from a publisher that is not on
    // its allow-list; a timer-driven path would spam that dialog and steal focus from the notebook.
    expect(canRequestKernelService('idle-guard')).toBe(false);
  });

  it('allows an explicit user action to request it', () => {
    expect(canRequestKernelService('user')).toBe(true);
  });
});

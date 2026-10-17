// TAG-03: a tag in a folder (`rel/1`) next to the annotated v1.0 of the fixture, so that the name rules have a hierarchy to refuse.
import type { SetupFn } from '../support';

export const setup: SetupFn = async (fx) => {
  fx.git('tag', 'rel/1', 'HEAD~1');
};

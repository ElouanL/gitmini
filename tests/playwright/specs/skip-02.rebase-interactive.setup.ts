// SKIP-02 starts from an interactive rebase of `feature` onto `main` stopped by `edit` on its first commit ("A: adds a.txt"),
// before the application opens. git has made the commit and written REBASE_HEAD; the index equals HEAD.
import type { SetupFn } from '../support';

export const setup: SetupFn = async (fx) => {
  fx.git('-c', "sequence.editor=sed -i.bak -e '1s/^pick/edit/'", 'rebase', '-i', 'main');
};

<script lang="ts">
  // Line buttons icons (stage, unstage, display, editor, solved): plotted 24×24, one line.
  type Name = 'stage' | 'unstage' | 'discard' | 'external' | 'check' | 'close' | 'chevron';
  const PATHS: Record<Name, string> = {
    stage: 'M12 5v14 M5 12h14',
    unstage: 'M5 12h14',
    discard: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
    external: 'M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    check: 'M5 12l5 5 9-10',
    close: 'M6 6l12 12 M18 6L6 18',
    chevron: 'M6 9l6 6 6-6',
  };
  let { name, size = 14 }: { name: Name; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={PATHS[name]} />
</svg>

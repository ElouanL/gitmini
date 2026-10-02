<script lang="ts">
  // The gitmini mark. Same geometry as `src-tauri/icons/gen_icon.py`; change both together.
  let { size = 40 }: { size?: number } = $props();
</script>

<svg class="logo" width={(size * 94.8) / 142.7} height={size} viewBox="0 0 94.8 142.7" aria-hidden="true">
  <path d="M21 21V121.7M21 107L73.8 56.2" fill="none" stroke="currentColor" stroke-width="15" stroke-linecap="round" />
  <circle cx="21" cy="21" r="21" fill="currentColor" />
  <circle cx="21" cy="121.7" r="21" fill="currentColor" />
  <circle cx="73.8" cy="56.2" r="21" fill="currentColor" />
</svg>

<style>
  .logo {
    flex: none;
    display: block;
    color: #f24b29;
  }
</style>

const OWNER = 'kabrio';
const REPOSITORY = 'surfboard';
const endpoint = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/releases/latest`;

const status = document.querySelector('#release-status');
const downloads = document.querySelector('#downloads');
const releaseMeta = document.querySelector('#release-meta');

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unavailable';
  const units = ['b', 'kb', 'mb', 'gb'];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function platformFor(name) {
  const value = name.toLowerCase();
  if (value.endsWith('.zip')) return 'macos';
  if (value.endsWith('.deb')) return 'linux · deb';
  if (value.endsWith('.rpm')) return 'linux · rpm';
  if (value.includes('sha256')) return 'checksums';
  return 'release asset';
}

function architectureFor(name) {
  const value = name.toLowerCase();
  if (value.includes('arm64') || value.includes('aarch64')) return 'arm64';
  if (value.includes('x64') || value.includes('amd64')) return 'x64';
  return 'universal / unspecified';
}

function renderRelease(release) {
  const assets = release.assets.filter(
    (asset) =>
      /\.(zip|deb|rpm)$/i.test(asset.name) || /sha256/i.test(asset.name),
  );
  status.textContent = assets.length ? 'latest release ready' : 'no assets yet';
  status.classList.toggle('ready', assets.length > 0);
  releaseMeta.hidden = false;
  releaseMeta.textContent = `${release.tag_name} · ${new Date(
    release.published_at,
  )
    .toISOString()
    .slice(0, 10)}`;
  downloads.replaceChildren();

  if (!assets.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'this release has no downloadable packages.';
    downloads.append(empty);
    return;
  }

  for (const asset of assets) {
    const card = document.createElement('article');
    card.className = 'download';
    const name = document.createElement('strong');
    name.textContent = asset.name;
    const meta = document.createElement('small');
    meta.textContent = `${platformFor(asset.name)} · ${architectureFor(asset.name)} · ${formatBytes(asset.size)}`;
    const link = document.createElement('a');
    link.className = 'button';
    link.href = asset.browser_download_url;
    link.textContent = asset.name.toLowerCase().includes('sha256')
      ? 'view checksums'
      : 'download';
    card.append(name, meta, link);
    downloads.append(card);
  }
}

fetch(endpoint, {
  headers: { Accept: 'application/vnd.github+json' },
})
  .then((response) => {
    if (response.status === 404) {
      status.textContent = 'no release published yet';
      return null;
    }
    if (!response.ok) throw new Error(`github returned ${response.status}`);
    return response.json();
  })
  .then((release) => {
    if (release) renderRelease(release);
  })
  .catch(() => {
    status.textContent = 'release lookup unavailable';
  });

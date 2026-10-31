export function artifactPlaybackURL(value, host) {
  try {
    const url = new URL(value);
    return (
      !!host &&
      url.origin === host &&
      /^\/api\/bots\/[\da-f-]{36}\/artifacts\/[\da-f-]{36}\/render$/.test(url.pathname) &&
      url.searchParams.get('play') === '1'
    );
  } catch {
    return false;
  }
}

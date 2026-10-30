// Empty stand-in for packages that are installed as dependencies but never loaded by the page
// (see "overrides" in package.json). The build's bundle contains none of them; if something
// ever does load one, fail loudly instead of running half-missing code.
throw new Error("This package is stubbed out of Fiber Recovery's install (see package.json overrides)");

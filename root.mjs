// One place for the working root: the upstream clone, the dev T3 homes, the demo project, logs.
// Override with ALLOW_FORKING_ROOT (Windows form with forward slashes, e.g. E:/work/allow-forking).
// The same default is in tools/env.sh.
export const AFW = (process.env.ALLOW_FORKING_ROOT ?? "D:/tmp/allow-forking").replaceAll("\\", "/").replace(/\/$/, "");

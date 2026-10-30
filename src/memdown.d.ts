// memdown ships no types; the engine only needs the in-memory LevelDOWN instance it returns.
declare module "memdown" {
  const memdown: () => unknown;
  export default memdown;
}

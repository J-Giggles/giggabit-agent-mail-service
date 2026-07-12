export function commandOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return value?.trim() || undefined;
}

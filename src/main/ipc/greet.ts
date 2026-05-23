export function greet(name: string): string {
  if (!name || !name.trim()) {
    throw new Error("name cannot be empty")
  }
  return `Hello, ${name}! Welcome to DesKit.`
}

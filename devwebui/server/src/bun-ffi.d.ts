// Minimal ambient types for the slice of `bun:ffi` used by metrics.ts. The project
// scopes tsconfig `types` to ["node"], so Bun's own globals aren't pulled in; this keeps
// the FFI call site type-checked without adding the full bun-types dependency.
declare module "bun:ffi" {
  /** FFI scalar tags we use (the real enum has many more members). */
  export const FFIType: {
    readonly u32: number;
    readonly i32: number;
    readonly ptr: number;
  };

  /** An opaque native pointer (Bun represents these as numbers). */
  export type Pointer = number;

  /** Pointer to a TypedArray's backing buffer; native writes are visible in the view. */
  export function ptr(view: ArrayBufferView): Pointer;

  interface Symbol {
    args: number[];
    returns: number;
  }

  export function dlopen(
    path: string,
    symbols: Record<string, Symbol>,
  ): {
    // Native boundary: each symbol is a callable taking numeric/pointer args.
    symbols: Record<string, (...args: (number | Pointer)[]) => number>;
    close(): void;
  };
}

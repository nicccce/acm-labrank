export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly retryAt?: string) {
    super(message);
    this.name = 'AppError';
  }
}

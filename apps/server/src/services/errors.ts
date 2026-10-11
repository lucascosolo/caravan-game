export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (message = "unauthorized") => new AppError(401, "unauthorized", message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

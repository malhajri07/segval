export class ApiError extends Error {
  constructor(public status: number, message: string, public path?: string) {
    super(message);
  }
}

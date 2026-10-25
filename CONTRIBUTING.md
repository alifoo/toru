# Contributing

Thanks for helping. Toru is MIT licensed, and so is everything you contribute.

- **Sign off your commits** (`git commit -s`). The `Signed-off-by` line certifies the
  [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or have the right to
  submit it under the MIT license. No CLA.
- **Open an issue first** for anything larger than a fix, so we can agree on the shape before you write it.
- **Run the checks** before opening a pull request: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`
  and `pnpm test` (the render tests need FFmpeg on the PATH).
- **Keep data out.** Never commit `.env` files, recordings, cookies, API keys or anyone's personal data, including in
  test fixtures: use `example.com`-style domains and invented names.
- **Questions** go to GitHub Discussions; security reports follow [SECURITY.md](SECURITY.md).

The "Toru" name and the lens mark are not part of the license; see [TRADEMARKS.md](TRADEMARKS.md).

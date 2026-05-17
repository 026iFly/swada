# SWADA — The Swedish Cardano Stake Pool

`pool1t9ckjy949dk97prfs6any8xdjyq9du6prnplx06n4fcn5jgukhc`

A small Cardano stake pool operated from Sweden by [Pelle Stensson](https://www.linkedin.com/in/pelle-stensson-ab31b65b/), originally registered 2021-03-01 and revived 2026.

The pool operator is also active in Cardano governance as the **iFly** DRep.

## Repository layout

| Path | Purpose |
|---|---|
| [`drep/iFly.jsonld`](drep/iFly.jsonld) | DRep metadata for iFly (CIP-119), referenced by the on-chain DRep anchor |
| [`pool/poolmeta.json`](pool/poolmeta.json) | On-chain pool metadata (CIP-006), referenced by the pool registration |
| `assets/iFly.png` | DRep & pool logo (512×512) |
| `website/` | Source for [swada.se](https://swada.se) (coming soon) |

## Pool details

- **Ticker**: SWADA
- **Homepage**: <https://swada.se>
- **Bech32 ID**: `pool1t9ckjy949dk97prfs6any8xdjyq9du6prnplx06n4fcn5jgukhc`
- **Hex ID**: `59716910b52b6c5f046986bb321ccd910056f3411cc3f33f53aa713a`
- **Pledge**: 75 000 ₳
- **Margin**: 1%
- **Fixed cost**: 170 ₳ (protocol minimum)

## DRep iFly

- **DRep ID (CIP-105)**: `drep1dk4vjsku5yzf8xzzx6ysaxk8l2pypjkza8xq86dvcpaccdwje5r`
- **DRep ID (CIP-129)**: `drep1yfk64j2zmjssfyucggmgjr56clagysx2ct5ucqlf4nq8hrqp23kfa`
- **Voting power**: pledge stake delegated to self-DRep

## How to use this metadata

Hashes referenced on-chain pin specific commits of this repository. Use commit-pinned raw URLs:

```
https://raw.githubusercontent.com/026iFly/swada/<commit-sha>/drep/iFly.jsonld
https://raw.githubusercontent.com/026iFly/swada/<commit-sha>/pool/poolmeta.json
```

## License

See [LICENSE](LICENSE) — MIT.

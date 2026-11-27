# Mappings

The mappings from the EHDS models to the Belgian models, one CSV per pair:
`<EHDSModel>--<BeModel>.csv` with the columns
`sourceCode, sourceDisplay, relationship, targetCode, targetDisplay, comment`.

Start one with `node src/cli.js new-mapping <EHDS id> --target <Belgian id>`, fill it in, then run
`node src/cli.js maps` to generate its ConceptMap in `generated/` (commit both; do not edit the
generated file). See the README.

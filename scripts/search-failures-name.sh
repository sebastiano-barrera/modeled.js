#!/bin/sh

pattern="$1"

awk -F'\t' -v pattern="$pattern" '
$1 == "case" { testcase = $2; m=0 }
$1 == "error" && !m && $2 ~ pattern { print testcase; m=1 }
'


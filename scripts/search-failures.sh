#!/bin/sh

pattern="$1"

awk -F'\t' -v pattern="$1" '
$1 == "case" {testcase = $2; pctx=0}
$1 == "error" && $2 ~ pattern { total++; print testcase ": " $2; pctx=1 }
pctx && $1 == "ectx" { print "\t", $2 }
END {print "total",total}
'


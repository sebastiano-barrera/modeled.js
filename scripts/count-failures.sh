#!/bin/sh

awk '$1 == "error" {print}' | sort | uniq -c | sort -n

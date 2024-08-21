#!/usr/bin/env python3

import sys
from collections import Counter
import os.path

dirs = Counter()

for line in sys.stdin:
	if not line.startswith('case'):
		continue

	tag, filename = line.split()
	assert tag == 'case'

	dir = os.path.dirname(filename)
	dirs[dir] += 1

for dir, count in reversed(dirs.most_common()):
	print('{:6} {}'.format(count, dir))

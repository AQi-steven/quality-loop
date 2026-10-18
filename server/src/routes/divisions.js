/**
 * 专业维度元数据（供前端构建级联下拉 / 折叠分组多选）
 *
 *   GET /api/divisions  → { divisions:[可见专业], divisionSubs:{专业: [二级,...]} }
 */

const express = require('express');
const db = require('../db/connection');
const { visibleDivisions, DIVISION_SUBS, orderDivisions } = require('../divisions');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  let divs = [];
  try {
    divs = db.prepare("SELECT DISTINCT division FROM users WHERE division IS NOT NULL AND division != '' AND is_active = 1").all().map(x => x.division);
  } catch (e) {}
  res.json({
    divisions: orderDivisions(divs),
    divisionSubs: DIVISION_SUBS,
  });
});

module.exports = router;

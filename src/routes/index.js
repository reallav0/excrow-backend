import { Router } from "express";

const router = Router();

// Catch-all route (Not Found)
router.use("*", (req, res) => {
  res.status(404).send("Not found!!!");
});

export default router;

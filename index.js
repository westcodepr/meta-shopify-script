const express = require('express');
const app = express();
const port = process.env.PORT || 8080;

app.get('/', async (req, res) => {
  console.log("✅ Script ejecutado correctamente desde Cloud Run.");
  res.send('¡El script se ejecutó correctamente desde Cloud Run!');
});

app.listen(port, () => {
  console.log(`🟢 Servidor escuchando en el puerto ${port}`);
});

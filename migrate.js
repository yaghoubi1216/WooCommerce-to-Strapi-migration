// ================= CONFIG =================

const WC_BASE = "https://bilchi.com/wp-json/wc/v3";
const STRAPI_BASE = "http://localhost:1337/api";

// you can set key and token into env file
const WC_KEY = "xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const WC_SECRET = "xxxxxxxxxxxxxxxxxxxxx";

const STRAPI_TOKEN = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

import axios from "axios";

const wc = axios.create({
  baseURL: WC_BASE,
  auth: {
    username: WC_KEY,
    password: WC_SECRET,
  },
});

const strapi = axios.create({
  baseURL: STRAPI_BASE,
  headers: {
    Authorization: `Bearer ${STRAPI_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// ///////////////////////////////////////// Upload Images to Strapi
import FormData from "form-data";
import fs from "fs";
import path from "path";
import slugify from "slugify";

// import fs from "fs";
// import path from "path";
// const TMP_DIR = path.resolve("./tmp");

// if (!fs.existsSync(TMP_DIR)) {
//   fs.mkdirSync(TMP_DIR, { recursive: true });
// }
// ================= SLUG GENERATOR =================
function normalizeWooProduct(raw) {
  return {
    id: raw["شناسه"],
    name: raw["نام"],
    description: raw["توضیحات"] || "",
    short_description: raw["توضیح کوتاه"] || "",
    sku: raw["شناسه محصول"] || "",
    price: raw["قیمت اصلی"] ? Number(raw["قیمت اصلی"]) : null,
    sale_price: raw["قیمت فروش فوق‌العاده"]
      ? Number(raw["قیمت فروش فوق‌العاده"])
      : null,
    stock_quantity: raw["میزان کمبود در انبار"]
      ? Number(raw["میزان کمبود در انبار"])
      : null,
    manage_stock: raw["در انبار؟"] === 1,
    type: raw["نوع"] || "simple",
    images: raw["تصاویر"]
      ? raw["تصاویر"].split(",").map((u) => ({ src: u.trim() }))
      : [],
    categories: raw["دسته‌ها"]
      ? raw["دسته‌ها"].split(">").map((c) => ({
          name: c.trim(),
        }))
      : [],
    attributes: {
      brand: raw["برندها"] || null,
      gtin: raw["GTIN UPC، EAN یا ISBN"] || null,
      mpn: raw["MPN"] || null,
    },
  };
}

function generateSlug(title, fallback = "item") {
  if (!title) return `${fallback}-${Date.now()}`;

  return title
    .trim()
    .toLowerCase()
    .replace(/[^\u0600-\u06FFa-z0-9\s-]/g, "") // keep Persian + Latin
    .replace(/\s+/g, "-") // spaces → -
    .replace(/-+/g, "-") // collapse ---
    .replace(/^-+|-+$/g, ""); // trim -
}

const uploadedImages = new Map();

async function uploadImage(url) {
  if (uploadedImages.has(url)) {
    return uploadedImages.get(url);
  }
  const TMP_DIR = path.resolve("./tmp");
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const filePath = path.join(TMP_DIR, path.basename(url));

  // download image
  const response = await axios.get(url, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  // upload to Strapi
  const form = new FormData();
  form.append("files", fs.createReadStream(filePath));

  const { data } = await axios.post("http://localhost:1337/api/upload", form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${STRAPI_TOKEN}`, // ✅ مهم
    },
  });

  fs.unlinkSync(filePath);
  uploadedImages.set(url, data[0].id);
  return data[0].id;
}

///////////////////////////////////  Create or Get Categories
async function getCategory(cat) {
  const safeSlug = generateSlug(cat.name, "category");

  const { data } = await strapi.get(
    `/categories?filters[slug][$eq]=${safeSlug}`
  );

  if (data.data.length) return data.data[0].id;

  const res = await strapi.post("/categories", {
    data: {
      name: cat.name,
      title: cat.name,
      slug: safeSlug,
    },
  });

  return res.data.data.id;
}

///////////////////////////////         Create Product in Strapi
async function createProduct(p, categoryIds) {
  return strapi.post("/products", {
    data: {
      title: p.name,
      titleEn: "",
      slug: `${generateSlug(p.name)}-${p.id}`,

      description: p.description,
      shortDescription: p.short_description,

      sku: p.sku,
      price: p.price,
      sale_price: p.sale_price,

      stock_quantity: p.stock_quantity,
      isAvailable: p.manage_stock,

      type: p.type,
      image: p.image || null,
      images: p.images || [],
      categories: categoryIds,
      parent: p.parent ? { connect: [p.parent] } : undefined,
      attributes: p.attributes,
    },
  });
}

/////////////////////////////////////////    Handle Variable Products + Variations
async function migrateProduct(product) {
  // ================= Categories =================
  const categoryIds = [];
  for (const c of product.categories || []) {
    categoryIds.push(await getCategory(c));
  }

  // ================= Images =================
  let mainImageId = null;
  const galleryImageIds = [];

  if (product.images?.length) {
    mainImageId = await uploadImage(product.images[0].src);

    for (let i = 1; i < product.images.length; i++) {
      galleryImageIds.push(await uploadImage(product.images[i].src));
    }
  }

  await createProduct(
    {
      ...product,
      image: mainImageId,
      images: galleryImageIds,
    },
    categoryIds
  );
}

// ================= VARIABLE PRODUCT (Parent)

////////////////////////////////9️⃣ Run Migration (Paginated)
async function migrateAll() {
  let page = 1;

  while (true) {
    const { data } = await wc.get("/products", {
      params: { per_page: 100, page },
    });

    if (!data.length) break;

    for (const product of data) {
      await migrateProduct(product);
      console.log(`✔ ${product.name}`);
    }

    page++;
  }
}

migrateAll();

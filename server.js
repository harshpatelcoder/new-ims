const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
let mongoUri = process.env.MONGODB_URI;

// Initialize MongoDB connection
async function connectDB() {
  if (!mongoUri) {
    if (process.env.NODE_ENV === 'production') {
      console.error('ERROR: MONGODB_URI environment variable is missing.');
      console.error('Please configure MONGODB_URI in your Render.com Environment Variables.');
      process.exit(1);
    } else {
      console.error('ERROR: MONGODB_URI environment variable is missing.');
      console.error('Please configure MONGODB_URI in your Render.com Environment Variables.');
      console.log('Development environment detected. Starting in-memory MongoDB fallback...');
      try {
        const { MongoMemoryServer } = require('mongodb-memory-server');
        const mongoServer = await MongoMemoryServer.create();
        mongoUri = mongoServer.getUri();
        console.log(`In-memory MongoDB started successfully at ${mongoUri}`);
      } catch (err) {
        console.error('Failed to start in-memory MongoDB:', err.message);
        process.exit(1);
      }
    }
  }

  try {
 await mongoose.connect(mongoUri, {
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000
});
    console.log('Connected successfully to MongoDB database.');
    await initSuperAdmin();
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
}

// Mongoose Schemas & Models
const shopSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  owner_name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, trim: true, default: '' },
  address: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  full_name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['super_admin', 'shop_admin', 'staff'], required: true },
  shop_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
  is_active: { type: Boolean, default: true },
  must_change_password: { type: Boolean, default: false },
  password_changed_at: { type: Date, default: Date.now },
  reset_password_token_hash: { type: String, default: null },
  reset_password_expires: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

userSchema.index({ shop_id: 1 });

const supplierSchema = new mongoose.Schema({
  shop_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  address: { type: String, trim: true, default: '' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

supplierSchema.index({ shop_id: 1 });

const productSchema = new mongoose.Schema({
  shop_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  name: { type: String, required: true, trim: true },
  brand: { type: String, trim: true, default: 'Generic' },
  category: { type: String, trim: true, default: 'General Paint' },
  subcategory: { type: String, trim: true, default: '' },
  shade: { type: String, trim: true, default: '' },
  size: { type: String, trim: true, default: '1L' },
  unit: { type: String, trim: true, default: 'Liters' },
  purchase_price: { type: Number, default: 0, min: 0 },
  selling_price: { type: Number, default: 0, min: 0 },
  stock: { type: Number, default: 0, min: 0 },
  minimum_stock: { type: Number, default: 5, min: 0 },
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
  description: { type: String, trim: true, default: '' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

productSchema.index({ shop_id: 1 });
productSchema.index({ shop_id: 1, name: 1 });
productSchema.index({ shop_id: 1, category: 1 });

const stockTransactionSchema = new mongoose.Schema({
  shop_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  type: { type: String, enum: ['IN', 'OUT'], required: true },
  quantity: { type: Number, required: true, min: 1 },
  previous_stock: { type: Number, required: true },
  new_stock: { type: Number, required: true },
  note: { type: String, trim: true, default: '' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  created_at: { type: Date, default: Date.now }
});

stockTransactionSchema.index({ shop_id: 1, created_at: -1 });

const activityLogSchema = new mongoose.Schema({
  shop_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  description: { type: String, required: true },
  created_at: { type: Date, default: Date.now }
});

activityLogSchema.index({ shop_id: 1, created_at: -1 });

const Shop = mongoose.model('Shop', shopSchema);
const User = mongoose.model('User', userSchema);
const Supplier = mongoose.model('Supplier', supplierSchema);
const Product = mongoose.model('Product', productSchema);
const StockTransaction = mongoose.model('StockTransaction', stockTransactionSchema);
const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

// Initial Super Admin Creator
async function initSuperAdmin() {
  try {
    const existingAdmin = await User.findOne({ role: 'super_admin' });
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash('123456', 10);
      const superAdmin = new User({
        full_name: 'Administrator',
        email: 'admin@gmail.com',
        password: hashedPassword,
        role: 'super_admin',
        shop_id: null,
        is_active: true,
        must_change_password: true,
        password_changed_at: new Date()
      });
      await superAdmin.save();
      console.log('Default super_admin account initialized: admin@gmail.com / 123456');
    }
  } catch (err) {
    console.error('Error in initSuperAdmin:', err.message);
  }
}

// Activity Logging Helper
async function logActivity(userId, action, description, shopId = null) {
  try {
    await ActivityLog.create({
      user_id: userId,
      shop_id: shopId,
      action,
      description,
      created_at: new Date()
    });
  } catch (err) {
    console.error('Failed to write activity log:', err.message);
  }
}

// Express App Initialization
const app = express();

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session Store Setup Middleware
app.use((req, res, next) => {
  session({
    secret: process.env.SESSION_SECRET || 'paint_ims_v2_secure_session_secret_98765',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: mongoUri,
      collectionName: 'sessions',
      ttl: 8 * 60 * 60
    }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8
    }
  })(req, res, next);
});

// CSRF Protection
function csrfProtection(req, res, next) {
  if (!req.session) return next();

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    req.session.flash = { type: 'danger', message: 'Security token mismatch or expired CSRF token. Please try again.' };
    return res.redirect(req.header('Referer') || '/app');
  }
  next();
}

app.use(csrfProtection);

// Rate Limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: 'Too many login attempts. Please try again after 15 minutes.'
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many password reset attempts. Please try again after 15 minutes.'
});

// Flash & Temporary Notice Helpers
function getFlash(req) {
  const flash = req.session.flash || null;
  req.session.flash = null;
  return flash;
}

function getTempNotice(req) {
  const notice = req.session.tempNotice || null;
  req.session.tempNotice = null;
  return notice;
}

// Authentication Middlewares
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }

  if (req.session.user.role !== 'super_admin' && req.session.user.shop_id) {
    Shop.findById(req.session.user.shop_id).then(shop => {
      if (!shop || shop.status !== 'active') {
        req.session.destroy();
        return res.redirect('/login?error=' + encodeURIComponent('Your shop account is currently inactive. Please contact support.'));
      }
      next();
    }).catch(err => {
      console.error('Error checking shop status:', err);
      next();
    });
  } else {
    next();
  }
}

function checkMustChangePassword(req, res, next) {
  const currentPage = req.query.page || req.body.page || 'dashboard';
  if (req.session.user.must_change_password && currentPage !== 'change_password') {
    return res.redirect('/app?page=change_password');
  }
  next();
}

// Root Route
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/app?page=dashboard');
  }
  res.redirect('/login');
});

// Authentication Routes
app.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/app?page=dashboard');
  }
  const error = req.query.error || null;
  const success = req.query.success || null;
  res.render('login', {
    viewMode: 'login',
    error,
    success,
    csrfToken: req.session.csrfToken || '',
    token: null
  });
});

app.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.redirect('/login?error=' + encodeURIComponent('Please enter both email and password.'));
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).populate('shop_id');
    if (!user) {
      return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
    }

    if (!user.is_active) {
      return res.redirect('/login?error=' + encodeURIComponent('Account disabled. Please contact your administrator.'));
    }

    if (user.role !== 'super_admin' && user.shop_id && user.shop_id.status !== 'active') {
      return res.redirect('/login?error=' + encodeURIComponent('Account disabled. Your paint shop is currently inactive.'));
    }

    req.session.regenerate(async (err) => {
      if (err) {
        console.error('Session regeneration error:', err);
        return res.redirect('/login?error=' + encodeURIComponent('Failed to initiate secure session.'));
      }

      req.session.user = {
        _id: user._id.toString(),
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        shop_id: user.shop_id ? user.shop_id._id.toString() : null,
        shop_name: user.shop_id ? user.shop_id.name : 'Platform System',
        must_change_password: user.must_change_password
      };
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');

      await logActivity(
        user._id,
        'Login',
        `User ${user.full_name} (${user.role}) logged in successfully.`,
        user.shop_id ? user.shop_id._id : null
      );

      if (user.must_change_password) {
        return res.redirect('/app?page=change_password');
      }
      return res.redirect('/app?page=dashboard');
    });
  } catch (err) {
    console.error('Login route error:', err);
    res.redirect('/login?error=' + encodeURIComponent('An unexpected error occurred during login.'));
  }
});

app.get('/logout', async (req, res) => {
  if (req.session && req.session.user) {
    await logActivity(
      req.session.user._id,
      'Logout',
      `User ${req.session.user.full_name} logged out.`,
      req.session.user.shop_id
    );
  }
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.redirect('/login?success=' + encodeURIComponent('You have been logged out securely.'));
  });
});

app.get('/forgot-password', (req, res) => {
  res.render('login', {
    viewMode: 'forgot',
    error: req.query.error || null,
    success: req.query.success || null,
    csrfToken: req.session.csrfToken || '',
    token: null
  });
});

app.post('/forgot-password', resetPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.render('login', {
        viewMode: 'forgot',
        error: 'Please enter your Super Admin email address.',
        success: null,
        csrfToken: req.session.csrfToken || '',
        token: null
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim(), role: 'super_admin' });
    let resetLinkNotice = null;

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      user.reset_password_token_hash = tokenHash;
      user.reset_password_expires = Date.now() + 15 * 60 * 1000;
      await user.save();

      resetLinkNotice = `/reset-password?token=${rawToken}`;
    }

    res.render('login', {
      viewMode: 'forgot',
      error: null,
      success: 'If a valid Super Admin account matches that email, password reset instructions have been generated.',
      csrfToken: req.session.csrfToken || '',
      token: resetLinkNotice
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.render('login', {
      viewMode: 'forgot',
      error: 'An error occurred while processing password reset request.',
      success: null,
      csrfToken: req.session.csrfToken || '',
      token: null
    });
  }
});

app.get('/reset-password', async (req, res) => {
  const rawToken = req.query.token;
  if (!rawToken) {
    return res.redirect('/login?error=' + encodeURIComponent('Missing password reset token.'));
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const user = await User.findOne({
    reset_password_token_hash: tokenHash,
    reset_password_expires: { $gt: Date.now() }
  });

  if (!user) {
    return res.redirect('/login?error=' + encodeURIComponent('Invalid or expired password reset token.'));
  }

  res.render('login', {
    viewMode: 'reset',
    error: null,
    success: null,
    csrfToken: req.session.csrfToken || '',
    token: rawToken
  });
});

app.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  try {
    const { token, password, confirm_password } = req.body;
    if (!token || !password || !confirm_password) {
      return res.render('login', {
        viewMode: 'reset',
        error: 'All fields are required.',
        success: null,
        csrfToken: req.session.csrfToken || '',
        token
      });
    }

    if (password.length < 8) {
      return res.render('login', {
        viewMode: 'reset',
        error: 'Password must be at least 8 characters in length.',
        success: null,
        csrfToken: req.session.csrfToken || '',
        token
      });
    }

    if (password !== confirm_password) {
      return res.render('login', {
        viewMode: 'reset',
        error: 'New password and confirm password do not match.',
        success: null,
        csrfToken: req.session.csrfToken || '',
        token
      });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      reset_password_token_hash: tokenHash,
      reset_password_expires: { $gt: Date.now() }
    });

    if (!user) {
      return res.redirect('/login?error=' + encodeURIComponent('Invalid or expired password reset token.'));
    }

    user.password = await bcrypt.hash(password, 10);
    user.reset_password_token_hash = null;
    user.reset_password_expires = null;
    user.must_change_password = false;
    user.password_changed_at = new Date();
    await user.save();

    await logActivity(user._id, 'Password Reset', 'Super Admin reset password via reset token.');

    res.redirect('/login?success=' + encodeURIComponent('Password reset successfully! Please log in with your new password.'));
  } catch (err) {
    console.error('Reset password error:', err);
    res.redirect('/login?error=' + encodeURIComponent('Failed to reset password. Please try again.'));
  }
});

// Main App Handler (GET & POST /app)
async function appHandler(req, res) {
  const currentUser = req.session.user;
  const method = req.method;
  let page = req.query.page || req.body.page || 'dashboard';

  // Handle POST actions first
  if (method === 'POST') {
    const action = req.body.action;

    try {
      // 1. Password Change Action
      if (action === 'change_password') {
        const { current_password, new_password, confirm_password } = req.body;
        if (!current_password || !new_password || !confirm_password) {
          req.session.flash = { type: 'danger', message: 'All password fields are required.' };
          return res.redirect('/app?page=change_password');
        }

        if (new_password.length < 8) {
          req.session.flash = { type: 'danger', message: 'New password must be at least 8 characters long.' };
          return res.redirect('/app?page=change_password');
        }

        if (new_password !== confirm_password) {
          req.session.flash = { type: 'danger', message: 'New password and confirm password do not match.' };
          return res.redirect('/app?page=change_password');
        }

        const userDoc = await User.findById(currentUser._id);
        const match = await bcrypt.compare(current_password, userDoc.password);
        if (!match) {
          req.session.flash = { type: 'danger', message: 'Current password entered is incorrect.' };
          return res.redirect('/app?page=change_password');
        }

        userDoc.password = await bcrypt.hash(new_password, 10);
        userDoc.must_change_password = false;
        userDoc.password_changed_at = new Date();
        userDoc.reset_password_token_hash = null;
        userDoc.reset_password_expires = null;
        await userDoc.save();

        req.session.user.must_change_password = false;

        await logActivity(currentUser._id, 'Password Change', 'User successfully changed account password.', currentUser.shop_id);

        req.session.flash = { type: 'success', message: 'Your password has been changed successfully.' };
        return res.redirect('/app?page=dashboard');
      }

      // 2. Super Admin Actions
      if (currentUser.role === 'super_admin') {
        if (action === 'create_shop') {
          const { name, owner_name, email, phone, address, admin_email, temp_password } = req.body;
          if (!name || !owner_name || !email || !admin_email) {
            req.session.flash = { type: 'danger', message: 'Shop Name, Owner Name, Email, and Admin Email are required.' };
            return res.redirect('/app?page=shops');
          }

          const existingUser = await User.findOne({ email: admin_email.toLowerCase().trim() });
          if (existingUser) {
            req.session.flash = { type: 'danger', message: `User with email "${admin_email}" already exists.` };
            return res.redirect('/app?page=shops');
          }

          const newShop = new Shop({
            name: name.trim(),
            owner_name: owner_name.trim(),
            email: email.toLowerCase().trim(),
            phone: (phone || '').trim(),
            address: (address || '').trim(),
            status: 'active'
          });
          await newShop.save();

          const tempPass = temp_password && temp_password.trim().length >= 6
            ? temp_password.trim()
            : crypto.randomBytes(4).toString('hex') + 'P!';

          const hashedPassword = await bcrypt.hash(tempPass, 10);

          const shopAdminUser = new User({
            full_name: owner_name.trim(),
            email: admin_email.toLowerCase().trim(),
            password: hashedPassword,
            role: 'shop_admin',
            shop_id: newShop._id,
            is_active: true,
            must_change_password: true,
            password_changed_at: new Date()
          });
          await shopAdminUser.save();

          req.session.tempNotice = {
            type: 'shop_created',
            shopName: newShop.name,
            email: shopAdminUser.email,
            tempPassword: tempPass
          };

          await logActivity(currentUser._id, 'Shop Created', `Created shop "${newShop.name}" and assigned Shop Admin (${shopAdminUser.email}).`);

          req.session.flash = { type: 'success', message: `Shop "${newShop.name}" created successfully!` };
          return res.redirect('/app?page=shops');
        }

        if (action === 'edit_shop') {
          const { shop_id, name, owner_name, email, phone, address, status } = req.body;
          if (!shop_id || !mongoose.Types.ObjectId.isValid(shop_id)) {
            req.session.flash = { type: 'danger', message: 'Invalid Shop ID.' };
            return res.redirect('/app?page=shops');
          }

          await Shop.findByIdAndUpdate(shop_id, {
            name: name.trim(),
            owner_name: owner_name.trim(),
            email: email.toLowerCase().trim(),
            phone: (phone || '').trim(),
            address: (address || '').trim(),
            status: status === 'inactive' ? 'inactive' : 'active',
            updated_at: new Date()
          });

          await logActivity(currentUser._id, 'Shop Updated', `Updated shop profile for "${name}".`);

          req.session.flash = { type: 'success', message: 'Shop details updated successfully.' };
          return res.redirect('/app?page=shops');
        }

        if (action === 'toggle_shop_status') {
          const { shop_id } = req.body;
          if (shop_id && mongoose.Types.ObjectId.isValid(shop_id)) {
            const shop = await Shop.findById(shop_id);
            if (shop) {
              shop.status = shop.status === 'active' ? 'inactive' : 'active';
              shop.updated_at = new Date();
              await shop.save();

              await logActivity(currentUser._id, 'Shop Status Toggled', `Changed status of "${shop.name}" to ${shop.status}.`);
              req.session.flash = { type: 'success', message: `Shop "${shop.name}" is now ${shop.status}.` };
            }
          }
          return res.redirect('/app?page=shops');
        }

        if (action === 'delete_shop') {
          const { shop_id } = req.body;
          if (shop_id && mongoose.Types.ObjectId.isValid(shop_id)) {
            const shop = await Shop.findById(shop_id);
            if (shop) {
              await Shop.findByIdAndDelete(shop_id);
              await User.deleteMany({ shop_id });
              await Product.deleteMany({ shop_id });
              await Supplier.deleteMany({ shop_id });
              await StockTransaction.deleteMany({ shop_id });
              await ActivityLog.deleteMany({ shop_id });

              await logActivity(currentUser._id, 'Shop Deleted', `Permanently deleted shop "${shop.name}" and all associated inventory/user data.`);
              req.session.flash = { type: 'success', message: `Shop "${shop.name}" deleted successfully.` };
            }
          }
          return res.redirect('/app?page=shops');
        }

        if (action === 'create_shop_admin') {
          const { shop_id, full_name, email, temp_password } = req.body;
          if (!shop_id || !full_name || !email) {
            req.session.flash = { type: 'danger', message: 'Shop selection, Full Name, and Email are required.' };
            return res.redirect('/app?page=shop_admins');
          }

          const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
          if (existingUser) {
            req.session.flash = { type: 'danger', message: `User with email "${email}" already exists.` };
            return res.redirect('/app?page=shop_admins');
          }

          const shop = await Shop.findById(shop_id);
          if (!shop) {
            req.session.flash = { type: 'danger', message: 'Selected shop does not exist.' };
            return res.redirect('/app?page=shop_admins');
          }

          const tempPass = temp_password && temp_password.trim().length >= 6
            ? temp_password.trim()
            : crypto.randomBytes(4).toString('hex') + 'A!';

          const hashedPassword = await bcrypt.hash(tempPass, 10);

          const newAdmin = new User({
            full_name: full_name.trim(),
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            role: 'shop_admin',
            shop_id: shop._id,
            is_active: true,
            must_change_password: true,
            password_changed_at: new Date()
          });
          await newAdmin.save();

          req.session.tempNotice = {
            type: 'admin_created',
            userName: newAdmin.full_name,
            email: newAdmin.email,
            tempPassword: tempPass,
            shopName: shop.name
          };

          await logActivity(currentUser._id, 'Shop Admin Created', `Created Shop Admin account for "${newAdmin.full_name}" (${shop.name}).`);
          req.session.flash = { type: 'success', message: 'Shop Admin created successfully.' };
          return res.redirect('/app?page=shop_admins');
        }

        if (action === 'reset_admin_password') {
          const { user_id } = req.body;
          if (user_id && mongoose.Types.ObjectId.isValid(user_id)) {
            const adminUser = await User.findById(user_id);
            if (adminUser) {
              const tempPass = crypto.randomBytes(4).toString('hex') + 'R!';
              adminUser.password = await bcrypt.hash(tempPass, 10);
              adminUser.must_change_password = true;
              adminUser.password_changed_at = new Date();
              adminUser.reset_password_token_hash = null;
              adminUser.reset_password_expires = null;
              await adminUser.save();

              req.session.tempNotice = {
                type: 'password_reset',
                userName: adminUser.full_name,
                email: adminUser.email,
                tempPassword: tempPass
              };

              await logActivity(currentUser._id, 'Password Reset', `Super Admin generated temporary password for Shop Admin "${adminUser.full_name}".`);
              req.session.flash = { type: 'success', message: 'Temporary password generated successfully.' };
            }
          }
          return res.redirect('/app?page=shop_admins');
        }
      }

      // 3. Shop Admin & Staff Actions
      if (['super_admin', 'shop_admin'].includes(currentUser.role)) {
        // Multi-tenant check: always enforce user's session shop_id
        const userShopId = currentUser.role === 'super_admin' ? (req.body.shop_id || currentUser.shop_id) : currentUser.shop_id;

        if (action === 'add_product') {
          const { name, brand, category, subcategory, shade, size, unit, purchase_price, selling_price, stock, minimum_stock, supplier_id, description } = req.body;

          if (!name || !name.trim()) {
            req.session.flash = { type: 'danger', message: 'Product Name is required.' };
            return res.redirect('/app?page=inventory');
          }

          if (!userShopId) {
            req.session.flash = { type: 'danger', message: 'No shop associated with user.' };
            return res.redirect('/app?page=inventory');
          }

          const numPurchase = Math.max(0, parseFloat(purchase_price) || 0);
          const numSelling = Math.max(0, parseFloat(selling_price) || 0);
          const numStock = Math.max(0, parseInt(stock) || 0);
          const numMinStock = Math.max(0, parseInt(minimum_stock) || 5);

          const product = new Product({
            shop_id: userShopId,
            name: name.trim(),
            brand: (brand || 'Generic').trim(),
            category: (category || 'General Paint').trim(),
            subcategory: (subcategory || '').trim(),
            shade: (shade || '').trim(),
            size: (size || '1L').trim(),
            unit: (unit || 'Liters').trim(),
            purchase_price: numPurchase,
            selling_price: numSelling,
            stock: numStock,
            minimum_stock: numMinStock,
            supplier_id: supplier_id && mongoose.Types.ObjectId.isValid(supplier_id) ? supplier_id : null,
            description: (description || '').trim()
          });

          await product.save();

          if (numStock > 0) {
            await StockTransaction.create({
              shop_id: userShopId,
              product_id: product._id,
              type: 'IN',
              quantity: numStock,
              previous_stock: 0,
              new_stock: numStock,
              note: 'Initial inventory stock on product entry.',
              created_by: currentUser._id
            });
          }

          await logActivity(currentUser._id, 'Product Created', `Added product "${product.name}" with initial stock ${numStock}.`, userShopId);

          req.session.flash = { type: 'success', message: `Product "${product.name}" added successfully.` };
          return res.redirect('/app?page=inventory');
        }

        if (action === 'edit_product') {
          const { product_id, name, brand, category, subcategory, shade, size, unit, purchase_price, selling_price, minimum_stock, supplier_id, description } = req.body;

          if (!product_id || !mongoose.Types.ObjectId.isValid(product_id)) {
            req.session.flash = { type: 'danger', message: 'Invalid product ID.' };
            return res.redirect('/app?page=inventory');
          }

          const product = await Product.findOne({ _id: product_id, shop_id: userShopId });
          if (!product) {
            req.session.flash = { type: 'danger', message: 'Product not found or access unauthorized.' };
            return res.redirect('/app?page=inventory');
          }

          product.name = name.trim();
          product.brand = (brand || 'Generic').trim();
          product.category = (category || 'General Paint').trim();
          product.subcategory = (subcategory || '').trim();
          product.shade = (shade || '').trim();
          product.size = (size || '1L').trim();
          product.unit = (unit || 'Liters').trim();
          product.purchase_price = Math.max(0, parseFloat(purchase_price) || 0);
          product.selling_price = Math.max(0, parseFloat(selling_price) || 0);
          product.minimum_stock = Math.max(0, parseInt(minimum_stock) || 5);
          product.supplier_id = supplier_id && mongoose.Types.ObjectId.isValid(supplier_id) ? supplier_id : null;
          product.description = (description || '').trim();
          product.updated_at = new Date();

          await product.save();

          await logActivity(currentUser._id, 'Product Updated', `Updated product details for "${product.name}".`, userShopId);

          req.session.flash = { type: 'success', message: `Product "${product.name}" updated successfully.` };
          return res.redirect('/app?page=inventory');
        }

        if (action === 'delete_product') {
          const { product_id } = req.body;
          if (product_id && mongoose.Types.ObjectId.isValid(product_id)) {
            const product = await Product.findOneAndDelete({ _id: product_id, shop_id: userShopId });
            if (product) {
              await logActivity(currentUser._id, 'Product Deleted', `Deleted product "${product.name}".`, userShopId);
              req.session.flash = { type: 'success', message: `Product "${product.name}" removed from inventory.` };
            }
          }
          return res.redirect('/app?page=inventory');
        }

        if (action === 'add_supplier') {
          const { name, phone, email, address } = req.body;
          if (!name || !name.trim()) {
            req.session.flash = { type: 'danger', message: 'Supplier Name is required.' };
            return res.redirect('/app?page=suppliers');
          }

          const supplier = new Supplier({
            shop_id: userShopId,
            name: name.trim(),
            phone: (phone || '').trim(),
            email: (email || '').toLowerCase().trim(),
            address: (address || '').trim()
          });
          await supplier.save();

          await logActivity(currentUser._id, 'Supplier Added', `Added supplier "${supplier.name}".`, userShopId);

          req.session.flash = { type: 'success', message: `Supplier "${supplier.name}" added successfully.` };
          return res.redirect('/app?page=suppliers');
        }

        if (action === 'edit_supplier') {
          const { supplier_id, name, phone, email, address } = req.body;
          if (supplier_id && mongoose.Types.ObjectId.isValid(supplier_id)) {
            const supplier = await Supplier.findOneAndUpdate(
              { _id: supplier_id, shop_id: userShopId },
              {
                name: name.trim(),
                phone: (phone || '').trim(),
                email: (email || '').toLowerCase().trim(),
                address: (address || '').trim(),
                updated_at: new Date()
              },
              { new: true }
            );

            if (supplier) {
              await logActivity(currentUser._id, 'Supplier Updated', `Updated supplier details for "${supplier.name}".`, userShopId);
              req.session.flash = { type: 'success', message: 'Supplier details updated successfully.' };
            }
          }
          return res.redirect('/app?page=suppliers');
        }

        if (action === 'delete_supplier') {
          const { supplier_id } = req.body;
          if (supplier_id && mongoose.Types.ObjectId.isValid(supplier_id)) {
            const supplier = await Supplier.findOneAndDelete({ _id: supplier_id, shop_id: userShopId });
            if (supplier) {
              await logActivity(currentUser._id, 'Supplier Deleted', `Deleted supplier "${supplier.name}".`, userShopId);
              req.session.flash = { type: 'success', message: `Supplier "${supplier.name}" removed.` };
            }
          }
          return res.redirect('/app?page=suppliers');
        }

        if (action === 'add_staff' && currentUser.role === 'shop_admin') {
          const { full_name, email, temp_password } = req.body;
          if (!full_name || !email) {
            req.session.flash = { type: 'danger', message: 'Staff Full Name and Email are required.' };
            return res.redirect('/app?page=staff');
          }

          const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
          if (existingUser) {
            req.session.flash = { type: 'danger', message: `User with email "${email}" already exists.` };
            return res.redirect('/app?page=staff');
          }

          const tempPass = temp_password && temp_password.trim().length >= 6
            ? temp_password.trim()
            : crypto.randomBytes(4).toString('hex') + 'S!';

          const hashedPassword = await bcrypt.hash(tempPass, 10);

          const staffUser = new User({
            full_name: full_name.trim(),
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            role: 'staff',
            shop_id: currentUser.shop_id,
            is_active: true,
            must_change_password: true,
            password_changed_at: new Date()
          });
          await staffUser.save();

          req.session.tempNotice = {
            type: 'staff_created',
            userName: staffUser.full_name,
            email: staffUser.email,
            tempPassword: tempPass
          };

          await logActivity(currentUser._id, 'Staff Account Created', `Created staff account for "${staffUser.full_name}".`, currentUser.shop_id);

          req.session.flash = { type: 'success', message: 'Staff account created successfully.' };
          return res.redirect('/app?page=staff');
        }

        if (action === 'reset_staff_password' && currentUser.role === 'shop_admin') {
          const { staff_id } = req.body;
          if (staff_id && mongoose.Types.ObjectId.isValid(staff_id)) {
            const staffUser = await User.findOne({ _id: staff_id, shop_id: currentUser.shop_id, role: 'staff' });
            if (staffUser) {
              const tempPass = crypto.randomBytes(4).toString('hex') + 'R!';
              staffUser.password = await bcrypt.hash(tempPass, 10);
              staffUser.must_change_password = true;
              staffUser.password_changed_at = new Date();
              await staffUser.save();

              req.session.tempNotice = {
                type: 'password_reset',
                userName: staffUser.full_name,
                email: staffUser.email,
                tempPassword: tempPass
              };

              await logActivity(currentUser._id, 'Staff Password Reset', `Shop Admin reset password for staff member "${staffUser.full_name}".`, currentUser.shop_id);
              req.session.flash = { type: 'success', message: 'Temporary password generated for staff member.' };
            }
          }
          return res.redirect('/app?page=staff');
        }

        if (action === 'toggle_user_status') {
          const { user_id } = req.body;
          if (user_id && mongoose.Types.ObjectId.isValid(user_id)) {
            let targetUser;
            if (currentUser.role === 'super_admin') {
              targetUser = await User.findById(user_id);
            } else {
              targetUser = await User.findOne({ _id: user_id, shop_id: currentUser.shop_id, role: 'staff' });
            }

            if (targetUser && targetUser._id.toString() !== currentUser._id) {
              targetUser.is_active = !targetUser.is_active;
              await targetUser.save();

              await logActivity(currentUser._id, 'User Status Toggled', `Toggled active status for user "${targetUser.full_name}" to ${targetUser.is_active}.`, targetUser.shop_id);
              req.session.flash = { type: 'success', message: `Account status for "${targetUser.full_name}" updated.` };
            }
          }
          return res.redirect(req.header('Referer') || '/app');
        }

        if (action === 'delete_staff' && currentUser.role === 'shop_admin') {
          const { staff_id } = req.body;
          if (staff_id && mongoose.Types.ObjectId.isValid(staff_id)) {
            const staff = await User.findOneAndDelete({ _id: staff_id, shop_id: currentUser.shop_id, role: 'staff' });
            if (staff) {
              await logActivity(currentUser._id, 'Staff Deleted', `Deleted staff account for "${staff.full_name}".`, currentUser.shop_id);
              req.session.flash = { type: 'success', message: `Staff member "${staff.full_name}" removed.` };
            }
          }
          return res.redirect('/app?page=staff');
        }
      }

      // 4. Stock IN / Stock OUT (Shop Admin & Staff)
      if (action === 'stock_in') {
        const { product_id, quantity, note } = req.body;
        const userShopId = currentUser.role === 'super_admin' ? (req.body.shop_id || currentUser.shop_id) : currentUser.shop_id;

        if (!product_id || !mongoose.Types.ObjectId.isValid(product_id)) {
          req.session.flash = { type: 'danger', message: 'Please select a valid product.' };
          return res.redirect('/app?page=stock_in');
        }

        const qtyNum = parseInt(quantity);
        if (isNaN(qtyNum) || qtyNum <= 0) {
          req.session.flash = { type: 'danger', message: 'Quantity must be a positive integer.' };
          return res.redirect('/app?page=stock_in');
        }

        const product = await Product.findOne({ _id: product_id, shop_id: userShopId });
        if (!product) {
          req.session.flash = { type: 'danger', message: 'Product not found.' };
          return res.redirect('/app?page=stock_in');
        }

        const prevStock = product.stock;
        const newStock = prevStock + qtyNum;

        product.stock = newStock;
        product.updated_at = new Date();
        await product.save();

        await StockTransaction.create({
          shop_id: userShopId,
          product_id: product._id,
          type: 'IN',
          quantity: qtyNum,
          previous_stock: prevStock,
          new_stock: newStock,
          note: (note || '').trim(),
          created_by: currentUser._id
        });

        await logActivity(currentUser._id, 'Stock IN', `Added ${qtyNum} units to "${product.name}" (New Stock: ${newStock}).`, userShopId);

        req.session.flash = { type: 'success', message: `Stock IN recorded! Added ${qtyNum} ${product.unit} to "${product.name}".` };
        return res.redirect('/app?page=inventory');
      }

      if (action === 'stock_out') {
        const { product_id, quantity, note } = req.body;
        const userShopId = currentUser.role === 'super_admin' ? (req.body.shop_id || currentUser.shop_id) : currentUser.shop_id;

        if (!product_id || !mongoose.Types.ObjectId.isValid(product_id)) {
          req.session.flash = { type: 'danger', message: 'Please select a valid product.' };
          return res.redirect('/app?page=stock_out');
        }

        const qtyNum = parseInt(quantity);
        if (isNaN(qtyNum) || qtyNum <= 0) {
          req.session.flash = { type: 'danger', message: 'Quantity must be a positive integer.' };
          return res.redirect('/app?page=stock_out');
        }

        const product = await Product.findOne({ _id: product_id, shop_id: userShopId });
        if (!product) {
          req.session.flash = { type: 'danger', message: 'Product not found.' };
          return res.redirect('/app?page=stock_out');
        }

        if (qtyNum > product.stock) {
          req.session.flash = { type: 'danger', message: `Stock OUT failed: Requested quantity (${qtyNum}) exceeds current available stock (${product.stock}).` };
          return res.redirect('/app?page=stock_out');
        }

        const prevStock = product.stock;
        const newStock = prevStock - qtyNum;

        product.stock = newStock;
        product.updated_at = new Date();
        await product.save();

        await StockTransaction.create({
          shop_id: userShopId,
          product_id: product._id,
          type: 'OUT',
          quantity: qtyNum,
          previous_stock: prevStock,
          new_stock: newStock,
          note: (note || '').trim(),
          created_by: currentUser._id
        });

        await logActivity(currentUser._id, 'Stock OUT', `Dispatched ${qtyNum} units from "${product.name}" (Remaining Stock: ${newStock}).`, userShopId);

        req.session.flash = { type: 'success', message: `Stock OUT recorded! Dispatched ${qtyNum} ${product.unit} of "${product.name}".` };
        return res.redirect('/app?page=inventory');
      }

    } catch (err) {
      console.error('App action POST error:', err);
      req.session.flash = { type: 'danger', message: 'An error occurred while executing request: ' + err.message };
      return res.redirect(`/app?page=${page}`);
    }
  }

  // GET Request Handling & Page Data Loading
  let targetShopId = currentUser.shop_id;

  // Super Admin can inspect specific shop inventory via query param
  if (currentUser.role === 'super_admin' && req.query.inspect_shop_id && mongoose.Types.ObjectId.isValid(req.query.inspect_shop_id)) {
    targetShopId = req.query.inspect_shop_id;
  }

  const renderData = {
    user: currentUser,
    page,
    flash: getFlash(req),
    tempNotice: getTempNotice(req),
    csrfToken: req.session.csrfToken || '',
    inspectShopId: targetShopId,
    inspectedShop: null
  };

  try {
    if (currentUser.role === 'super_admin' && targetShopId) {
      renderData.inspectedShop = await Shop.findById(targetShopId);
    }

    if (page === 'dashboard') {
      if (currentUser.role === 'super_admin') {
        const totalShops = await Shop.countDocuments();
        const activeShops = await Shop.countDocuments({ status: 'active' });
        const inactiveShops = await Shop.countDocuments({ status: 'inactive' });
        const totalShopAdmins = await User.countDocuments({ role: 'shop_admin' });
        const totalStaff = await User.countDocuments({ role: 'staff' });
        const totalProducts = await Product.countDocuments();

        const priceAgg = await Product.aggregate([
          { $group: { _id: null, totalVal: { $sum: { $multiply: ['$stock', '$selling_price'] } }, totalUnits: { $sum: '$stock' } } }
        ]);

        const totalInventoryValue = priceAgg.length > 0 ? priceAgg[0].totalVal : 0;
        const totalStockUnits = priceAgg.length > 0 ? priceAgg[0].totalUnits : 0;

        const recentShops = await Shop.find().sort({ created_at: -1 }).limit(5);

        const categoryAgg = await Product.aggregate([
          { $group: { _id: '$category', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 }
        ]);

        renderData.dashboardData = {
          totalShops,
          activeShops,
          inactiveShops,
          totalShopAdmins,
          totalStaff,
          totalProducts,
          totalInventoryValue,
          totalStockUnits,
          recentShops,
          categoryBreakdown: categoryAgg
        };
      } else {
        const shopIdFilter = targetShopId;
        const totalProducts = await Product.countDocuments({ shop_id: shopIdFilter });
        const totalSuppliers = await Supplier.countDocuments({ shop_id: shopIdFilter });

        const priceAgg = await Product.aggregate([
          { $match: { shop_id: new mongoose.Types.ObjectId(shopIdFilter) } },
          { $group: { _id: null, totalVal: { $sum: { $multiply: ['$stock', '$selling_price'] } }, totalUnits: { $sum: '$stock' } } }
        ]);

        const inventoryValue = priceAgg.length > 0 ? priceAgg[0].totalVal : 0;
        const totalStock = priceAgg.length > 0 ? priceAgg[0].totalUnits : 0;

        const allProducts = await Product.find({ shop_id: shopIdFilter });
        const lowStockProducts = allProducts.filter(p => p.stock <= p.minimum_stock && p.stock > 0);
        const outOfStockProducts = allProducts.filter(p => p.stock === 0);

        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const stockInMonth = await StockTransaction.aggregate([
          { $match: { shop_id: new mongoose.Types.ObjectId(shopIdFilter), type: 'IN', created_at: { $gte: startOfMonth } } },
          { $group: { _id: null, total: { $sum: '$quantity' } } }
        ]);

        const stockOutMonth = await StockTransaction.aggregate([
          { $match: { shop_id: new mongoose.Types.ObjectId(shopIdFilter), type: 'OUT', created_at: { $gte: startOfMonth } } },
          { $group: { _id: null, total: { $sum: '$quantity' } } }
        ]);

        const recentTransactions = await StockTransaction.find({ shop_id: shopIdFilter })
          .populate('product_id', 'name brand category size unit')
          .populate('created_by', 'full_name')
          .sort({ created_at: -1 })
          .limit(8);

        const categoryAgg = await Product.aggregate([
          { $match: { shop_id: new mongoose.Types.ObjectId(shopIdFilter) } },
          { $group: { _id: '$category', count: { $sum: 1 }, totalStock: { $sum: '$stock' } } },
          { $sort: { count: -1 } }
        ]);

        renderData.dashboardData = {
          totalProducts,
          totalStock,
          inventoryValue,
          lowStockCount: lowStockProducts.length,
          outOfStockCount: outOfStockProducts.length,
          totalSuppliers,
          stockInThisMonth: stockInMonth.length > 0 ? stockInMonth[0].total : 0,
          stockOutThisMonth: stockOutMonth.length > 0 ? stockOutMonth[0].total : 0,
          recentTransactions,
          lowStockProducts: lowStockProducts.slice(0, 5),
          categoryBreakdown: categoryAgg
        };
      }
    } else if (page === 'shops' && currentUser.role === 'super_admin') {
      const search = (req.query.search || '').trim();
      let query = {};
      if (search) {
        query = {
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { owner_name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
          ]
        };
      }

      const shopsList = await Shop.find(query).sort({ created_at: -1 });

      // Augment shops with product & admin counts
      const shopsWithMeta = await Promise.all(shopsList.map(async (s) => {
        const productCount = await Product.countDocuments({ shop_id: s._id });
        const adminUser = await User.findOne({ shop_id: s._id, role: 'shop_admin' });
        const priceAgg = await Product.aggregate([
          { $match: { shop_id: s._id } },
          { $group: { _id: null, totalUnits: { $sum: '$stock' } } }
        ]);

        return {
          ...s.toObject(),
          productCount,
          totalStock: priceAgg.length > 0 ? priceAgg[0].totalUnits : 0,
          adminUser: adminUser ? adminUser.toObject() : null
        };
      }));

      renderData.shops = shopsWithMeta;
      renderData.search = search;
    } else if (page === 'shop_admins' && currentUser.role === 'super_admin') {
      const search = (req.query.search || '').trim();
      let query = { role: 'shop_admin' };
      if (search) {
        query.$or = [
          { full_name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }

      const admins = await User.find(query).populate('shop_id').sort({ created_at: -1 });
      const activeShops = await Shop.find({ status: 'active' }).sort({ name: 1 });

      renderData.shopAdmins = admins;
      renderData.allShops = activeShops;
      renderData.search = search;
    } else if (page === 'inventory') {
      const shopIdFilter = targetShopId;
      const { search, brand, category, stock_status, sort } = req.query;

      let queryFilter = { shop_id: shopIdFilter };

      if (search && search.trim()) {
        const regex = { $regex: search.trim(), $options: 'i' };
        queryFilter.$or = [
          { name: regex },
          { brand: regex },
          { category: regex },
          { shade: regex }
        ];
      }

      if (brand && brand.trim()) {
        queryFilter.brand = brand.trim();
      }

      if (category && category.trim()) {
        queryFilter.category = category.trim();
      }

      let sortOption = { name: 1 };
      if (sort === 'stock_low') sortOption = { stock: 1 };
      if (sort === 'stock_high') sortOption = { stock: -1 };
      if (sort === 'price_high') sortOption = { selling_price: -1 };
      if (sort === 'price_low') sortOption = { selling_price: 1 };

      let productsList = await Product.find(queryFilter).populate('supplier_id', 'name').sort(sortOption);

      if (stock_status === 'low') {
        productsList = productsList.filter(p => p.stock <= p.minimum_stock && p.stock > 0);
      } else if (stock_status === 'out') {
        productsList = productsList.filter(p => p.stock === 0);
      } else if (stock_status === 'in') {
        productsList = productsList.filter(p => p.stock > p.minimum_stock);
      }

      const suppliers = await Supplier.find({ shop_id: shopIdFilter }).sort({ name: 1 });
      const distinctBrands = await Product.distinct('brand', { shop_id: shopIdFilter });
      const distinctCategories = await Product.distinct('category', { shop_id: shopIdFilter });

      renderData.products = productsList;
      renderData.suppliers = suppliers;
      renderData.distinctBrands = distinctBrands;
      renderData.distinctCategories = distinctCategories;
      renderData.query = { search, brand, category, stock_status, sort };
    } else if (page === 'stock_in' || page === 'stock_out') {
      const shopIdFilter = targetShopId;
      const products = await Product.find({ shop_id: shopIdFilter }).sort({ name: 1 });
      const suppliers = await Supplier.find({ shop_id: shopIdFilter }).sort({ name: 1 });
      renderData.products = products;
      renderData.suppliers = suppliers;
      renderData.selectedProductId = req.query.product_id || null;
    } else if (page === 'suppliers') {
      const shopIdFilter = targetShopId;
      const search = (req.query.search || '').trim();
      let query = { shop_id: shopIdFilter };

      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } }
        ];
      }

      const suppliersList = await Supplier.find(query).sort({ name: 1 });
      renderData.suppliers = suppliersList;
      renderData.search = search;
    } else if (page === 'staff') {
      if (currentUser.role === 'staff') {
        return res.redirect('/app?page=dashboard');
      }
      const shopIdFilter = targetShopId;
      const staffList = await User.find({ shop_id: shopIdFilter, role: 'staff' }).sort({ created_at: -1 });
      renderData.staffMembers = staffList;
    } else if (page === 'stock_history') {
      const shopIdFilter = targetShopId;
      let queryFilter = {};

      if (currentUser.role !== 'super_admin' || shopIdFilter) {
        queryFilter.shop_id = shopIdFilter;
      }

      const transactions = await StockTransaction.find(queryFilter)
        .populate('product_id')
        .populate('created_by', 'full_name role')
        .sort({ created_at: -1 })
        .limit(100);

      renderData.transactions = transactions;
    } else if (page === 'activity') {
      let queryFilter = {};
      if (currentUser.role !== 'super_admin' || targetShopId) {
        queryFilter.shop_id = targetShopId;
      }

      const activities = await ActivityLog.find(queryFilter)
        .populate('user_id', 'full_name role email')
        .populate('shop_id', 'name')
        .sort({ created_at: -1 })
        .limit(100);

      renderData.activities = activities;
    } else if (page === 'reports') {
      const shopIdFilter = targetShopId;
      const products = await Product.find({ shop_id: shopIdFilter }).populate('supplier_id', 'name');

      const totalVal = products.reduce((acc, p) => acc + (p.stock * p.selling_price), 0);
      const totalCost = products.reduce((acc, p) => acc + (p.stock * p.purchase_price), 0);
      const estimatedMargin = totalVal - totalCost;

      const topStocked = [...products].sort((a, b) => (b.stock * b.selling_price) - (a.stock * a.selling_price)).slice(0, 10);
      const lowStockItems = products.filter(p => p.stock <= p.minimum_stock);

      const recentTx = await StockTransaction.find({ shop_id: shopIdFilter })
        .populate('product_id', 'name')
        .sort({ created_at: -1 })
        .limit(20);

      renderData.reportData = {
        totalInventoryValue: totalVal,
        totalInventoryCost: totalCost,
        estimatedMargin,
        topStocked,
        lowStockItems,
        recentTx
      };
    } else if (page === 'profile') {
      const userDoc = await User.findById(currentUser._id).populate('shop_id');
      renderData.profileUser = userDoc;
    }

    res.render('app', renderData);
  } catch (err) {
    console.error('App handler GET error:', err);
    res.status(500).send('An unexpected server error occurred: ' + err.message);
  }
}

// Router Bindings
app.get('/app', requireAuth, checkMustChangePassword, appHandler);
app.post('/app', requireAuth, checkMustChangePassword, appHandler);

// 404 Catch-All Route
app.use((req, res) => {
  res.status(404).send(`Route Not Found: ${req.method} ${req.url}`);
});

// Start Server
connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Paint IMS V2 server running securely on port ${PORT}`);
  });
});

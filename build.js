const Hexo = require('hexo');

async function build() {
  const hexo = new Hexo(process.cwd(), {
    silent: false
  });
  
  try {
    await hexo.init();
    await hexo.call('generate', {});
    await hexo.exit();
    console.log('Hexo build completed!');
  } catch (error) {
    console.error('Hexo build failed:', error);
    process.exit(1);
  }
}

build();
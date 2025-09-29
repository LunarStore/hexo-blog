---
title: STM32F103时钟分析
date: 2024-06-11 12:00:00
tags:
  - STM32
---

## SystemInit系统初始化时钟源码分析

伪代码如下：

<!-- more -->
```cpp
/**
  * @brief  Setup the microcontroller system
  *         Initialize the Embedded Flash Interface, the PLL and update the 
  *         SystemCoreClock variable.
  * @note   This function should be used only after reset.
  * @param  None
  * @retval None
  */
void SystemInit (void)
{
  /* Reset the RCC clock configuration to the default reset state(for debug purpose) */

  /*
   *  时钟控制寄存器：
   *  将RCC_CR的第0（HSION）位赋1，高速内部时钟使能,其他位不变
   */
  /* Set HSION bit */
  RCC->CR |= (uint32_t)0x00000001;

  /*
   *  时钟配置寄存器：
   *  将RCC_CFGR的SW[1:0]、SWS[3:2]、HPRE[7:4]、PPRE1[10:8]、PPRE2[13:11]、
   *  ADCPRE[15:14]、MCO[26:24]置零，其他位不变。
   */
  /* Reset SW, HPRE, PPRE1, PPRE2, ADCPRE and MCO bits */
  RCC->CFGR &= (uint32_t)0xF8FF0000;  
  
  /*
   *  时钟控制寄存器：
   *  将RCC_CR的HSEON[16]、CSSON[19]、PLLON[24]置零，其他位不变。
   */
  /* Reset HSEON, CSSON and PLLON bits */
  RCC->CR &= (uint32_t)0xFEF6FFFF;

  /*
   *  时钟控制寄存器：
   *  将RCC_CR的HSEBYP[18]置零，其他位不变。
   */
  /* Reset HSEBYP bit */
  RCC->CR &= (uint32_t)0xFFFBFFFF;

  /*
   *  时钟控制寄存器：
   *  将RCC_CR的PLLSRC、PLLXTPRE、PLLMUL、USBPRE置零，其他位不变。[16:23]
   */
  /* Reset PLLSRC, PLLXTPRE, PLLMUL and USBPRE/OTGFSPRE bits */
  RCC->CFGR &= (uint32_t)0xFF80FFFF;

  /*
   *  时钟中断寄存器：
   *  将RCC_CR的[16:20]位、PLLRDYC[20]、CSSC[23]等置1，其他为0.
   */
  /* Disable all interrupts and clear pending bits  */
  RCC->CIR = 0x009F0000;

  /* Configure the System clock frequency, HCLK, PCLK2 and PCLK1 prescalers */
  /* Configure the Flash Latency cycles and enable prefetch buffer */
  SetSysClock();

  SCB->VTOR = FLASH_BASE | VECT_TAB_OFFSET; /* Vector Table Relocation in Internal FLASH. */
}
```

结合STM32F1XX中文参考手册，我对上面的代码进行了注释。


```cpp
/**
  * @brief  Configures the System clock frequency, HCLK, PCLK2 and PCLK1 prescalers.
  * @param  None
  * @retval None
  */
static void SetSysClock(void)
{
#ifdef SYSCLK_FREQ_HSE
  SetSysClockToHSE();
#elif defined SYSCLK_FREQ_24MHz
  //  ...
#elif defined SYSCLK_FREQ_72MHz
  SetSysClockTo72();
#endif
 
 /* If none of the define above is enabled, the HSI is used as System clock
    source (default after reset) */ 
}
```

系统时钟初始化核心函数：

```cpp
/**
  * @brief  Sets System clock frequency to 72MHz and configure HCLK, PCLK2 
  *         and PCLK1 prescalers. 
  * @note   This function should be used only after reset.
  * @param  None
  * @retval None
  */
static void SetSysClockTo72(void)
{
  __IO uint32_t StartUpCounter = 0, HSEStatus = 0;
  
  /* SYSCLK, HCLK, PCLK2 and PCLK1 configuration ---------------------------*/    
  // 使HSE时钟源使能。[16]
  /* Enable HSE */    
  RCC->CR |= ((uint32_t)RCC_CR_HSEON);
 
  // 循环等待RCC_CR寄存器的HSERDY[17]被置为1，此时才代表HSE时钟稳定了。
  /* Wait till HSE is ready and if Time out is reached exit */
  do
  {
    HSEStatus = RCC->CR & RCC_CR_HSERDY;
    StartUpCounter++;  
  } while((HSEStatus == 0) && (StartUpCounter != HSE_STARTUP_TIMEOUT));

  if ((RCC->CR & RCC_CR_HSERDY) != RESET)
  {
    HSEStatus = (uint32_t)0x01;
  }
  else
  {
    HSEStatus = (uint32_t)0x00;
  }  

  if (HSEStatus == (uint32_t)0x01)
  {
    /*
     *  省略无关代码...
     */

    // 设置CDGR寄存器的HPRE[7:4]，AHB预分频器分频系数为1。
    /* HCLK = SYSCLK */
    RCC->CFGR |= (uint32_t)RCC_CFGR_HPRE_DIV1; // 0000  // 72MHz

    // 设置CDGR寄存器的PPRE2[13:11]，APB2预分频器分频系数为1。
    /* PCLK2 = HCLK */
    RCC->CFGR |= (uint32_t)RCC_CFGR_PPRE2_DIV1; // 000  // 72MHz
    
    // 设置CDGR寄存器的PPRE1[10:8]，APB1预分频器分频系数为2。
    /* PCLK1 = HCLK */
    RCC->CFGR |= (uint32_t)RCC_CFGR_PPRE1_DIV2; // 100  // APB1最高只能36MHz

    // 1、先将：PLLSRC[16]、PLLXTPRE[17]、PLLMUL[18:21]全置0，
    // 2、PLLSRC[16]置为1，PLLXTPRE[17]保持为0，PLLMUL[21:18]置为0111
    // 结果就是将HSE分频器的输出作为PLL输入时钟源，并且PLLMUL的备品系数设为9.
    /*  PLL configuration: PLLCLK = HSE * 9 = 72 MHz */
    RCC->CFGR &= (uint32_t)((uint32_t)~(RCC_CFGR_PLLSRC | RCC_CFGR_PLLXTPRE |
                                        RCC_CFGR_PLLMULL));
    RCC->CFGR |= (uint32_t)(RCC_CFGR_PLLSRC_HSE | RCC_CFGR_PLLMULL9);

    // PLLON[24]置为1，打开PLL时钟
    /* Enable PLL */
    RCC->CR |= RCC_CR_PLLON;

    // PLLRDY被置为，等待PLL时钟稳定。
    /* Wait till PLL is ready */
    while((RCC->CR & RCC_CR_PLLRDY) == 0)
    {
    }
    
    // 1、SW[1:0]置为 00
    // 2、SW[1:0]置为 10，设置sw选择器选择PLL输出作为系统时钟
    /* Select PLL as system clock source */
    RCC->CFGR &= (uint32_t)((uint32_t)~(RCC_CFGR_SW));
    RCC->CFGR |= (uint32_t)RCC_CFGR_SW_PLL;    

    // 等待SWS[3:2]被置为 10，等待时钟稳定。
    /* Wait till PLL is used as system clock source */
    while ((RCC->CFGR & (uint32_t)RCC_CFGR_SWS) != (uint32_t)0x08)
    {
    }
  }
  else
  { /* If HSE fails to start-up, the application will have wrong clock 
         configuration. User can add here some code to deal with this error */
  }
}
```

PLLON为0才能对PLLSRC、PLLXTPRE、PLLMUL设置！！！
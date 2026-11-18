package com.yuzhua;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/**
 * 愈爪|宠物医院预约与在线问诊平台 —— 后端启动类
 */
@SpringBootApplication
@EnableTransactionManagement
@EnableScheduling
@ConfigurationPropertiesScan("com.yuzhua.config")
@MapperScan("com.yuzhua.mapper")
public class YuzhuaApplication {

    public static void main(String[] args) {
        SpringApplication.run(YuzhuaApplication.class, args);
    }
}

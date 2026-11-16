package com.petclinic;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/**
 * 宠物医院预约问诊系统 —— 后端启动类
 */
@SpringBootApplication
@EnableTransactionManagement
@EnableScheduling
@ConfigurationPropertiesScan("com.petclinic.config")
@MapperScan("com.petclinic.mapper")
public class PetClinicApplication {

    public static void main(String[] args) {
        SpringApplication.run(PetClinicApplication.class, args);
    }
}
